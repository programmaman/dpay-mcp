/**
 * Error formatting -- wraps the SDK error decoder with additional ERC20 errors.
 *
 * The SDK knows dpayments contract custom errors.  This module adds common
 * OpenZeppelin ERC20 errors on top, so the MCP server gets the full picture.
 *
 * Import this instead of calling `error.message` directly in tool handlers:
 *
 * ```ts
 * catch (error) {
 *   return { content: [{ type: 'text', text: `my_tool failed: ${formatRevert(error)}` }], isError: true };
 * }
 * ```
 */

import { decodeDPaymentError } from '@rakelabs/dpayments-sdk';
import { Interface } from 'ethers';
import { logger as baseLogger } from './logger.js';

const logger = baseLogger.child({ component: 'error-format' });

// -- Additional errors not yet in the SDK -- OpenZeppelin ERC20 suite -------

const ERC20_IFACE = new Interface([
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InvalidApprover(address approver)',
  'error ERC20InvalidSpender(address spender)',
  'error ERC20InvalidSender(address sender)',
  'error ERC20InvalidReceiver(address receiver)',
]);

/** Try the SDK decoder first, then ERC20 errors. */
function decodeCombined(data: string): { error: string; args: Record<string, unknown> } | null {
  // Nothing to decode -- let formatRevert fall through to error.message
  if (!data || data === '0x') return null;

  // 1. SDK known dpayments errors
  const sdkResult = decodeDPaymentError({ data });
  if (sdkResult && 'error' in sdkResult) return sdkResult;

  // 2. ERC20 errors
  try {
    const decoded = ERC20_IFACE.parseError(data);
    if (!decoded) return null;
    const args: Record<string, unknown> = {};
    decoded.fragment.inputs.forEach((input, i) => {
      const key = input.name && input.name.length > 0 ? input.name : String(i);
      args[key] = decoded.args[i];
    });
    return { error: decoded.name, args };
  } catch {
    // Unknown revert selector -- log so we know what to add
    const selector = data.length >= 10 ? data.slice(0, 10) : data;
    logger.debug({ selector }, 'Unknown revert selector');
    return null;
  }
}

// -- Revert data extraction (shared logic) -----------------------------------

const HEX_DATA_RE = /^0x[0-9a-fA-F]*$/;

function isHexData(value: unknown): value is string {
  return typeof value === 'string' && HEX_DATA_RE.test(value) && value.length >= 10;
}

function readRevertData(value: unknown, seen: Set<object>, depth: number): string | null {
  if (value == null || depth > 8) return null;
  if (isHexData(value)) return value;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readRevertData(item, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== 'object') return null;

  const objectValue = value as Record<string, unknown>;
  if (seen.has(objectValue)) return null;
  seen.add(objectValue);

  for (const key of ['data', 'error', 'info', 'cause', 'originalError', 'response'] as const) {
    const found = readRevertData(objectValue[key], seen, depth + 1);
    if (found) return found;
  }

  return null;
}

function extractRevertData(err: unknown): string | null {
  return readRevertData(err, new Set<object>(), 0);
}

// -- Public API ---------------------------------------------------------------

/**
 * Format a wallet-level revert into a short human-readable string.
 *
 * Tries the SDK's known dpayments errors first, then falls back to
 * standard OpenZeppelin ERC20 errors.  Falls through to `error.message`
 * when nothing matches.
 */
export function formatRevert(error: unknown): string {
  const data = extractRevertData(error);
  if (!data) {
    return error instanceof Error ? error.message : String(error);
  }

  const decoded = decodeCombined(data);
  if (decoded) {
    const args = Object.entries(decoded.args)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ');
    return `${decoded.error}${args ? ` (${args})` : ''}`;
  }

  return error instanceof Error ? error.message : String(error);
}
