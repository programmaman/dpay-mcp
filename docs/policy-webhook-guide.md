# Policy Webhook Guide

The policy webhook is an optional external compliance check that runs before write operations. It is meant for environments where an operator wants a separate service to approve or deny tool calls before the MCP server submits an on-chain transaction or otherwise mutates state.

## Enable It

Set the following environment variables before starting `dpay-mcp`:

- `POLICY_WEBHOOK_URL`: the HTTPS endpoint to call for policy decisions.
- `POLICY_WEBHOOK_TOKEN`: optional bearer token for webhook authentication.

If `POLICY_WEBHOOK_URL` is not set, the server skips the webhook and allows the request.

## End-To-End Flow

The policy webhook is not called by the MCP client directly. The flow is:

1. The MCP client sends a tool call to `dpay-mcp`.
2. The tool call may include optional `_meta` data.
3. `dpay-mcp` forwards the tool name, tool args, wallet address, chain ID, and `_meta` as `meta` to the policy webhook.
4. The policy webhook returns `allowed: true` or `allowed: false`.
5. If the webhook denies the request, `dpay-mcp` stops and returns a policy error to the client.

Client request example:

```json
{
  "tool": "eth_create_payment",
  "arguments": {
    "payeeAddress": "0xabc...",
    "etherAmount": "0.01",
    "settlementWindowSec": "86400"
  },
  "_meta": {
    "clientName": "claude-desktop",
    "tenant": "acme"
  }
}
```

What `dpay-mcp` sends to the policy webhook:

```json
{
  "tool": "eth_create_payment",
  "args": {
    "payeeAddress": "0xabc...",
    "etherAmount": "0.01",
    "settlementWindowSec": "86400"
  },
  "walletAddress": "0xeF5b8CeFd6b8adfbc144bF51D14d7315cD5eC90f",
  "chainId": 1,
  "meta": {
    "clientName": "claude-desktop",
    "tenant": "acme"
  }
}
```

If the policy service rejects the call, it can return:

```json
{
  "allowed": false,
  "reason": "Manager approval required for payments above 0.25 ETH."
}
```

In that case, `dpay-mcp` does not submit the transaction.

## Which Tools Use It

The webhook runs before every write operation in the server:

- `eth_create_payment`
- `erc20_create_payment`
- `raise_dispute`
- `submit_evidence`
- `settle`
- `refund`

Read-only tools such as `whoami` and `payment_info` do not call the webhook.

## Request Shape

For each protected tool call, the server sends a `POST` request with JSON. The `meta` field is the MCP call's optional `_meta` payload, forwarded from the tool invocation:

```json
{
  "tool": "eth_create_payment",
  "args": {
    "payeeAddress": "0x...",
    "etherAmount": "0.01"
  },
  "walletAddress": "0xeF5b8CeFd6b8adfbc144bF51D14d7315cD5eC90f",
  "chainId": 1,
  "meta": {}
}
```

Notes:

- The server strips `_meta` out of `args` and passes it separately as `meta`.
- The request includes the wallet address currently controlling the server and the configured chain ID.

In the code, that forwarding happens in `src/index.ts` before `checkPolicy(...)` is called.

If `POLICY_WEBHOOK_TOKEN` is set, the request includes:

```http
Authorization: Bearer <token>
```

## Response Shape

The webhook should return JSON with this shape:

```json
{
  "allowed": true,
  "reason": "optional human-readable note"
}
```

Behavior:

- `allowed: true` lets the tool call continue.
- `allowed: false` blocks the request.
- If `reason` is present on a denial, it is surfaced back to the caller.

## Fail-Closed Behavior

The webhook is intentionally fail-closed.

The server denies the request if any of the following happens:

- the webhook returns a non-2xx response
- the webhook returns invalid or unexpected JSON
- the webhook request times out
- the webhook is unreachable or raises a network error

The timeout is 3 seconds.

## Recommended Webhook Contract

Keep the policy service small and deterministic. A good implementation should:

- authenticate requests from `dpay-mcp`
- inspect the tool name, args, wallet, and chain ID
- return a clear denial reason when blocking a request
- avoid side effects before it decides

## Realistic Company Rule Example

Suppose a company wants to let agents pay vendors, but only under a few internal controls:

- payments above 0.25 ETH require manager approval
- disputes are only allowed for internal accounts on weekdays
- refunds are only allowed for payments whose `paymentAddress` is already in the company ledger
- evidence submissions must include a non-empty `argument`

A policy webhook can enforce this by reading the incoming `tool`, `args`, `walletAddress`, and `chainId`, then applying company-specific rules before returning `allowed: true` or `allowed: false`.

Example denial response:

```json
{
  "allowed": false,
  "reason": "Manager approval required for payments above 0.25 ETH."
}
```

That keeps the business rule outside the model and inside a dedicated policy service, which is easier to audit and change without redeploying the MCP server.

## Example Denial

```json
{
  "allowed": false,
  "reason": "Payment amount exceeds policy limit."
}
```

## When To Use It

Use the policy webhook when you need a separate control plane for compliance, approvals, or corporate governance. Leave it unset when you want the server to operate without an external dependency.

## Note

This implementation is still a little complicated and may change as the design settles.