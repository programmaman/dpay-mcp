/**
 * ConfigEnforcer — validates parsed tool inputs against configured spending limits.
 *
 * One `validate(input, tokenAddress)` call per tool handler checks everything
 * relevant to that input shape. Throw on violation = block the transaction.
 *
 * Supports:
 *   eth_create_payment / erc20_create_payment  — checks allowlist, value + settlement window
 */

import { ethers } from 'ethers';
import { NaturalLanguageToChainConverter } from './natural-language-converter.js';

// ─── Types ─────────────────────────────────────────────────────────

export interface AllowedTokenConfig {
  /** Token contract address (checksummed or lowercase). */
  address: string;
  /** Human-readable session budget. Example: "0.5" for 0.5 units. */
  budget: string;
  /** Human-readable max per-tx value. Example: "0.1" for 0.1 units. */
  maxTxValue: string;
}

// ─── Aliases ────────────────────────────────────────────────────────

/** Known token name aliases → contract addresses. */
const KNOWN_ALIASES: Record<string, string> = {
  ETH: '0x0000000000000000000000000000000000000000',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};

function resolveAddress(raw: string): string {
  const trimmed = raw.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return trimmed;
  const alias = Object.entries(KNOWN_ALIASES).find(
    ([name]) => name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (alias) return alias[1];
  throw new Error(
    `Unknown token "${raw}". Use a hex address or one of: ${Object.keys(KNOWN_ALIASES).join(', ')}`,
  );
}

// ═════════════════════════════════════════════════════════════════════
// ConfigEnforcer
// ═════════════════════════════════════════════════════════════════════

export class ConfigEnforcer {
  private readonly _resolved = new Map<string, { budgetWei: bigint; maxTxValueWei: bigint }>();
  private _sessionSpent = new Map<string, bigint>();
  private _allowedTokens: AllowedTokenConfig[];
  private readonly _minSettlementWindowSec: bigint;

  constructor(
    allowedTokens: AllowedTokenConfig[],
    private readonly converter: NaturalLanguageToChainConverter,
    minSettlementWindowSec?: bigint,
  ) {
    this._allowedTokens = allowedTokens;
    this._minSettlementWindowSec = minSettlementWindowSec ?? 0n;
  }

  // ─── Static factory ───────────────────────────────────────────────

  static fromEnv(converter: NaturalLanguageToChainConverter): ConfigEnforcer {
    const allowedTokens = ConfigEnforcer.parseAllowedTokensEnv();
    const minSettlementWindowSec = ConfigEnforcer.parseSec('MIN_SETTLEMENT_WINDOW_SEC');

    process.stderr.write(
      `[dpay-mcp] Spending limits: tokens=${allowedTokens.length} ` +
      `minSettlementWindow=${minSettlementWindowSec || 'none'}\n`,
    );

    return new ConfigEnforcer(allowedTokens, converter, minSettlementWindowSec);
  }

  private static parseAllowedTokensEnv(): AllowedTokenConfig[] {
    const raw = process.env['ALLOWED_TOKENS'];
    if (!raw || !raw.trim()) {
      throw new Error(
        'ALLOWED_TOKENS is required. ' +
        'Format: address|name:budget:maxTxValue,address|name:budget:maxTxValue. ' +
        'Built-in aliases: ETH, USDC. For other tokens, use the hex contract address. ' +
        'Example: ALLOWED_TOKENS=ETH:0.1:0.01,0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:500:100',
      );
    }
    return raw.split(',').map((triple, i) => {
      const parts = triple.split(':');
      if (parts.length !== 3) {
        throw new Error(`Invalid ALLOWED_TOKENS entry at index ${i}: "${triple}". Expected format address:budget:maxTxValue`);
      }
      const [rawAddr, budget, maxTxValue] = parts;
      if (parseFloat(budget) <= 0) {
        throw new Error(`Invalid ALLOWED_TOKENS entry at index ${i}: budget "${budget}" must be a positive number`);
      }
      if (parseFloat(maxTxValue) <= 0) {
        throw new Error(`Invalid ALLOWED_TOKENS entry at index ${i}: maxTxValue "${maxTxValue}" must be a positive number`);
      }
      return { address: resolveAddress(rawAddr), budget, maxTxValue };
    });
  }

  private static parseSec(key: string): bigint | undefined {
    const raw = process.env[key];
    if (!raw) return undefined;
    try {
      const val = BigInt(raw);
      if (val >= 0n) return val;
      process.stderr.write(`[dpay-mcp] ⚠ Invalid ${key}="${raw}", treating as no minimum\n`);
      return 0n;
    } catch {
      process.stderr.write(`[dpay-mcp] ⚠ Invalid ${key}="${raw}", treating as no minimum\n`);
      return 0n;
    }
  }

  // ─── Public accessors ─────────────────────────────────────────────

  /** Configured token addresses (read-only). */
  get allowedTokenAddresses(): string[] {
    return this._allowedTokens.map(t => t.address);
  }

  /** Configured minimum settlement window in seconds. */
  get minSettlementWindowSec(): bigint {
    return this._minSettlementWindowSec;
  }

  /** Human-readable limits enriched with token symbols for LLM consumption. */
  async humanReadableLimits(): Promise<Array<{ token: string; budget: string; maxTxValue: string }>> {
    return Promise.all(this._allowedTokens.map(async (t) => {
      const details = await this.converter.getTokenDetails(t.address);
      const symbol = details.symbol ?? t.address.slice(0, 10);
      return {
        token: symbol,
        budget: `${t.budget} ${symbol}`,
        maxTxValue: `${t.maxTxValue} ${symbol}`,
      };
    }));
  }

  // ─── Validation ───────────────────────────────────────────────────

  async validate(input: Record<string, unknown>, tokenAddress: string): Promise<void> {
    this.checkAllowlist(tokenAddress);
    await this.resolveIfNeeded(tokenAddress);
    this.checkSettlementWindow(input);
    this.checkValue(input, tokenAddress);
  }

  recordSpend(valueWei: bigint, tokenAddress: string): void {
    const key = tokenAddress.toLowerCase();
    const current = this._sessionSpent.get(key) ?? 0n;
    this._sessionSpent.set(key, current + valueWei);
  }

  // ─── Per-token getters ────────────────────────────────────────────

  getTokenSpent(tokenAddress: string): bigint {
    return this._sessionSpent.get(tokenAddress.toLowerCase()) ?? 0n;
  }

  async getBudgetRemaining(tokenAddress: string): Promise<bigint> {
    await this.resolveIfNeeded(tokenAddress);
    const key = tokenAddress.toLowerCase();
    const resolved = this._resolved.get(key);
    if (!resolved || resolved.budgetWei === 0n) return 0n;
    const spent = this._sessionSpent.get(key) ?? 0n;
    const remaining = resolved.budgetWei - spent;
    return remaining > 0n ? remaining : 0n;
  }

  async isSpendExhausted(tokenAddress: string): Promise<boolean> {
    await this.resolveIfNeeded(tokenAddress);
    const key = tokenAddress.toLowerCase();
    const resolved = this._resolved.get(key);
    if (!resolved || resolved.budgetWei === 0n) return true;
    const spent = this._sessionSpent.get(key) ?? 0n;
    return spent >= resolved.budgetWei;
  }

  async getTokenBudgetConfig(tokenAddress: string): Promise<{
    budget: string;
    maxTxValue: string;
    symbol?: string;
    name?: string;
    budgetWei: bigint;
    maxTxValueWei: bigint;
    spentWei: bigint;
    remainingWei: bigint;
    exhausted: boolean;
  } | null> {
    const cfg = this._allowedTokens.find(t => t.address.toLowerCase() === tokenAddress.toLowerCase());
    if (!cfg) return null;

    await this.resolveIfNeeded(tokenAddress);
    const details = await this.converter.getTokenDetails(tokenAddress);
    const resolved = this._resolved.get(tokenAddress.toLowerCase())!;

    return {
      budget: cfg.budget,
      maxTxValue: cfg.maxTxValue,
      symbol: details.symbol,
      name: details.name,
      budgetWei: resolved.budgetWei,
      maxTxValueWei: resolved.maxTxValueWei,
      spentWei: this.getTokenSpent(tokenAddress),
      remainingWei: await this.getBudgetRemaining(tokenAddress),
      exhausted: await this.isSpendExhausted(tokenAddress),
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private checkAllowlist(tokenAddress: string): void {
    if (this._allowedTokens.length === 0) return;
    const key = tokenAddress.toLowerCase();
    const found = this._allowedTokens.some(t => t.address.toLowerCase() === key);
    if (!found) {
      throw new Error(
        `Token ${tokenAddress} is not in the allowlist. ` +
        `Configured tokens: ${this._allowedTokens.map(t => t.address).join(', ') || 'none'}.`,
      );
    }
  }

  private async resolveIfNeeded(tokenAddress: string): Promise<void> {
    const key = tokenAddress.toLowerCase();
    if (this._resolved.has(key)) return;

    if (key === ethers.ZeroAddress.toLowerCase()) {
      const cfg = this._allowedTokens.find(t => t.address.toLowerCase() === key);
      if (cfg) {
        this._resolved.set(key, {
          budgetWei: ethers.parseEther(cfg.budget),
          maxTxValueWei: ethers.parseEther(cfg.maxTxValue),
        });
      } else {
        this._resolved.set(key, { budgetWei: 0n, maxTxValueWei: 0n });
      }
      return;
    }

    const cfg = this._allowedTokens.find(t => t.address.toLowerCase() === key);
    if (cfg) {
      const { decimals } = await this.converter.getTokenDetails(tokenAddress);
      this._resolved.set(key, {
        budgetWei: ethers.parseUnits(cfg.budget, decimals),
        maxTxValueWei: ethers.parseUnits(cfg.maxTxValue, decimals),
      });
    } else {
      this._resolved.set(key, { budgetWei: 0n, maxTxValueWei: 0n });
    }
  }

  private parseValue(input: Record<string, unknown>): bigint | undefined {
    const raw = input['netAmountWei'] ?? input['amountWei'];
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'bigint') return undefined;
    try {
      const val = BigInt(raw);
      return val >= 0n ? val : undefined;
    } catch {
      return undefined;
    }
  }

  private checkValue(input: Record<string, unknown>, tokenAddress: string): void {
    const valueWei = this.parseValue(input);
    if (valueWei === undefined) return;

    const key = tokenAddress.toLowerCase();
    const resolved = this._resolved.get(key) ?? { budgetWei: 0n, maxTxValueWei: 0n };

    if (resolved.maxTxValueWei === 0n || valueWei > resolved.maxTxValueWei) {
      if (resolved.maxTxValueWei > 0n) {
        throw new Error(
          `Transaction value ${valueWei} exceeds per-tx limit of ${resolved.maxTxValueWei} for token ${tokenAddress}.`,
        );
      }
      throw new Error(
        `Transaction value ${valueWei} is not allowed — per-tx limit is 0 for token ${tokenAddress}. No transactions permitted.`,
      );
    }

    const spent = this._sessionSpent.get(key) ?? 0n;
    const afterSpend = spent + valueWei;
    if (resolved.budgetWei === 0n || afterSpend > resolved.budgetWei) {
      if (resolved.budgetWei > 0n) {
        throw new Error(
          `Transaction would exceed session budget for token ${tokenAddress}. ` +
          `Spent so far: ${spent}, this tx: ${valueWei}, budget: ${resolved.budgetWei}.`,
        );
      }
      throw new Error(
        `Transaction value ${valueWei} is not allowed — session budget is 0 for token ${tokenAddress}. No transactions permitted.`,
      );
    }
  }

  private checkSettlementWindow(input: Record<string, unknown>): void {
    const raw = input['settlementTimeUnixSec'];
    if (!raw || this._minSettlementWindowSec === 0n) return;

    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'bigint') return;
    let settlementTime: bigint;
    try {
      settlementTime = BigInt(raw);
    } catch {
      return;
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const window = settlementTime - now;

    if (window < this._minSettlementWindowSec) {
      const suggested = now + this._minSettlementWindowSec;
      throw new Error(
        `Settlement window ${window}s is below minimum of ${this._minSettlementWindowSec}s. ` +
        `Set settlementTimeUnixSec to at least ${suggested}.`,
      );
    }
  }
}