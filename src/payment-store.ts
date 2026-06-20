import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PaymentRecord {
  paymentAddress: string;
  chainId: number;
  payee: string;
  /** Present for ETH payments. */
  etherAmount?: string;
  /** Present for ERC20 payments. */
  tokenAddress?: string;
  tokenAmount?: string;
  /** Cached on-chain state: PAID, DISPUTED, SETTLED, RESOLVED. */
  state: string;
  /** Unix timestamp of creation. */
  createdAt: number;
  /** Evidence URIs submitted for this payment. */
  evidenceUris: string[];
  /** Optional human label. */
  label?: string;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class PaymentStore {
  private records = new Map<string, PaymentRecord>();
  private readonly filePath: string;

  constructor(baseDir?: string) {
    const dir = baseDir ?? join(homedir(), '.dpay-mcp');
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'payments.json');
    this.load();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  get(address: string): PaymentRecord | undefined {
    return this.records.get(address.toLowerCase());
  }

  list(): PaymentRecord[] {
    return Array.from(this.records.values());
  }

  async upsert(address: string, update: Partial<PaymentRecord>): Promise<PaymentRecord> {
    const key = address.toLowerCase();
    const existing = this.records.get(key) ?? {
      paymentAddress: address,
      chainId: 0,
      payee: '',
      state: 'UNKNOWN',
      createdAt: Math.floor(Date.now() / 1000),
      evidenceUris: [],
    };
    const merged: PaymentRecord = { ...existing, ...update, paymentAddress: address };
    this.records.set(key, merged);
    await this.flush();
    return merged;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, PaymentRecord>;
      for (const [key, val] of Object.entries(parsed)) {
        this.records.set(key, val);
      }
    } catch (err) {
      // Corrupted file — start fresh
      process.stderr.write(`[dpay-mcp] ⚠ Failed to load payments.json: ${String(err)}\n`);
    }
  }

  private async flush(): Promise<void> {
    try {
      const obj: Record<string, PaymentRecord> = {};
      for (const [key, val] of this.records) {
        obj[key] = val;
      }
      await writeFile(this.filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      process.stderr.write(`[dpay-mcp] ⚠ Failed to write payments.json: ${String(err)}\n`);
    }
  }
}
