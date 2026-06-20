import { ethers } from 'ethers';

const ERC20_DETAILS_ABI = [
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
];

/** Cache getBlock('latest') results for this many ms (≈1 block on most chains). */
const BLOCK_CACHE_TTL_MS = 12_000;

export interface TokenDetails {
  decimals: number;
  name?: string;
  symbol?: string;
}

/**
 * Converts human-readable inputs (ETH amounts, ERC20 amounts, settlement windows)
 * into chain-ready values (wei, base units, absolute timestamps).
 *
 * All calls are read-only — no state changes.
 * Block and token details are cached to avoid redundant RPC calls.
 */
export class NaturalLanguageToChainConverter {
  private blockCache: { ts: number; block: ethers.Block } | undefined;
  private tokenDetailsCache = new Map<string, TokenDetails>();

  constructor(private provider: ethers.Provider) {}

  // ─── ETH ────────────────────────────────────────────────────────────────

  /**
   * Converts a human-readable ETH amount to wei.
   * Example: "0.001" → 1000000000000000n
   */
  ethToWei(humanAmount: string): bigint {
    return ethers.parseEther(humanAmount);
  }

  // ─── Token details ──────────────────────────────────────────────────────

  /**
   * Get on-chain metadata for a token address.
   * - ETH (ZeroAddress) → hardcoded { decimals: 18, name: "Ethereum", symbol: "ETH" }. No RPC.
   * - ERC20 → fetches decimals, name, symbol in parallel. Cached indefinitely.
   */
  async getTokenDetails(address: string): Promise<TokenDetails> {
    const key = address.toLowerCase();
    const cached = this.tokenDetailsCache.get(key);
    if (cached !== undefined) return cached;

    // ETH special case — no RPC
    if (key === ethers.ZeroAddress.toLowerCase()) {
      const eth: TokenDetails = { decimals: 18, name: 'Ethereum', symbol: 'ETH' };
      this.tokenDetailsCache.set(key, eth);
      return eth;
    }

    const token = new ethers.Contract(address, ERC20_DETAILS_ABI, this.provider);
    const [decimalsResult, nameResult, symbolResult] = await Promise.allSettled([
      token.decimals() as Promise<number>,
      token.name() as Promise<string>,
      token.symbol() as Promise<string>,
    ]);

    const details: TokenDetails = {
      decimals: decimalsResult.status === 'fulfilled' ? decimalsResult.value : 18,
    };
    if (nameResult.status === 'fulfilled') details.name = nameResult.value;
    if (symbolResult.status === 'fulfilled') details.symbol = symbolResult.value;

    this.tokenDetailsCache.set(key, details);
    return details;
  }

  // ─── ERC20 ──────────────────────────────────────────────────────────────

  /**
   * Converts a human-readable ERC20 amount to token base units by
   * fetching the token's `decimals()` on-chain.
   * Results are cached indefinitely per token address (decimals are immutable).
   * Example: ("0x...", "1") → 1000000n for USDC (6 decimals)
   */
  async erc20ToBaseUnits(tokenAddress: string, humanAmount: string): Promise<bigint> {
    const { decimals } = await this.getTokenDetails(tokenAddress);
    return ethers.parseUnits(humanAmount, decimals);
  }

  // ─── Settlement window ──────────────────────────────────────────────────

  /**
   * Computes an absolute Unix settlement timestamp from a relative window
   * in seconds, anchored to the latest block's timestamp.
   * The block is cached for ~12 seconds to avoid redundant RPC calls.
   * Example: "86400" → (latestBlockTs + 86400n)
   */
  async settlementTimestamp(windowSec: string): Promise<{ blockNumber: number; blockTs: bigint; settlementTimeUnixSec: bigint }> {
    const block = await this.fetchLatestBlock();
    const blockTs = BigInt(block.timestamp);
    const windowSecBig = BigInt(windowSec);
    return {
      blockNumber: block.number,
      blockTs,
      settlementTimeUnixSec: blockTs + windowSecBig,
    };
  }

  private async fetchLatestBlock(): Promise<ethers.Block> {
    const now = Date.now();
    if (this.blockCache && (now - this.blockCache.ts) < BLOCK_CACHE_TTL_MS) {
      return this.blockCache.block;
    }
    const block = await this.provider.getBlock('latest');
    if (!block) throw new Error('Failed to fetch latest block');
    this.blockCache = { ts: now, block };
    return block;
  }
}
