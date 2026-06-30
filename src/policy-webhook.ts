/**
 * Policy webhook — optional external compliance check before write tools.
 *
 * Set POLICY_WEBHOOK_URL and optionally POLICY_WEBHOOK_TOKEN to enable.
 * The webhook receives the tool call and returns { allowed: boolean, reason?: string }.
 * When no URL is configured, all requests are allowed (zero overhead).
 */

import { logger as baseLogger, formatError } from './logger.js';

// ─── Config (loaded once at module init) ─────────────────────────────────

const policyWebhookUrl = process.env['POLICY_WEBHOOK_URL'] ?? '';
const policyWebhookToken = process.env['POLICY_WEBHOOK_TOKEN'] ?? '';
const logger = baseLogger.child({ component: 'policy-webhook' });

// ─── Types ────────────────────────────────────────────────────────────────

export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
}

// ─── Check ────────────────────────────────────────────────────────────────

/**
 * Check the policy webhook for a given tool call.
 *
 * Strips `_meta` from args (if present) and passes it as the meta parameter.
 * Returns `{ allowed: true }` immediately when no webhook is configured.
 * Fail-closed: any network error, timeout, or non-200 response denies the request.
 */
export async function checkPolicy(
  tool: string,
  args: Record<string, unknown>,
  walletAddress: string,
  chainId: number,
): Promise<PolicyCheckResult> {
  if (!policyWebhookUrl) return { allowed: true };

  const meta = args['_meta'] as Record<string, unknown> | undefined;

  // Clone args and strip _meta so it's not duplicated in the payload
  const cleanArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k !== '_meta') cleanArgs[k] = v;
  }

  try {
    const res = await fetch(policyWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(policyWebhookToken && { 'Authorization': `Bearer ${policyWebhookToken}` }),
      },
      body: JSON.stringify({ tool, args: cleanArgs, walletAddress, chainId, meta }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      logger.warn({ tool, statusCode: res.status }, 'Policy webhook denied request with non-OK response');
      return { allowed: false, reason: `Policy check failed (HTTP ${res.status})` };
    }

    const result = await res.json() as Record<string, unknown>;
    const isAllowed = result['allowed'] === true;
    const reason = isAllowed
      ? undefined
      : (typeof result['reason'] === 'string' ? result['reason'] : 'Blocked by corporate policy.');

    if (!isAllowed) {
      logger.warn({ tool, reason }, 'Policy webhook denied request');
    }

    return { allowed: isAllowed, reason };

  } catch (err) {
    logger.error({ tool, err, reason: formatError(err) }, 'Policy webhook error or timeout; denying request');
    return { allowed: false, reason: 'Policy check unreachable or timed out.' };
  }
}
