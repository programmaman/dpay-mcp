<div align="center">

# dpay-mcp

An MCP server for creating, settling, disputing, and refunding escrows on EVM chains.

<p>
  <strong>AI agents call MCP tools.</strong> The server submits the on-chain transactions, so the agent never needs to hold a private key.
</p>

<p>
  <a href="https://www.npmjs.com/package/@rakelabs/dpay-mcp"><img src="https://img.shields.io/npm/v/@rakelabs/dpay-mcp.svg" alt="npm version"></a>
  <a href="https://github.com/programmaman/dpay-mcp"><img src="https://img.shields.io/badge/repo-github-24292f.svg" alt="GitHub"></a>
  <a href="https://github.com/programmaman/dpay-mcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-6f42c1.svg" alt="Model Context Protocol"></a>
</p>

</div>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#more-client-options">More Options</a> ·
  <a href="#development">Development</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#configuration">Configuration</a>
</p>

---

## Quick Start

Configure the MCP server in your client. Restart, then tell your agent what to do.

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "dpay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@rakelabs/dpay-mcp"],
      "env": {
        "RPC_URL": "${env:RPC_URL}",
        "CHAIN_ID": "${env:CHAIN_ID}",
        "PRIVATE_KEY": "${env:PRIVATE_KEY}",
        "ALLOWED_TOKENS": "${env:ALLOWED_TOKENS}"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dpay": {
      "command": "npx",
      "args": ["-y", "@rakelabs/dpay-mcp"],
      "env": {
        "RPC_URL": "${RPC_URL}",
        "CHAIN_ID": "${CHAIN_ID}",
        "PRIVATE_KEY": "${PRIVATE_KEY}",
        "ALLOWED_TOKENS": "${ALLOWED_TOKENS}"
      }
    }
  }
}
```

### Done

Restart your client. Ask your agent:

```
I want to do business on chain, what's your wallet address?
```

## More Client Options

### Inline values (less secure)

Quick start — replace with your values:

**Claude Desktop:**

```json
{
  "mcpServers": {
    "dpay": {
      "command": "npx",
      "args": ["-y", "@rakelabs/dpay-mcp"],
      "env": {
        "RPC_URL": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
        "CHAIN_ID": "1",
        "PRIVATE_KEY": "0x...",
        "ALLOWED_TOKENS": "ETH:0.1:0.01"
      }
    }
  }
}
```

**VS Code:**

```json
{
  "servers": {
    "dpay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@rakelabs/dpay-mcp"],
      "env": {
        "RPC_URL": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
        "CHAIN_ID": "1",
        "PRIVATE_KEY": "0x...",
        "ALLOWED_TOKENS": "ETH:0.1:0.01"
      }
    }
  }
}
```

### Windows

npx can hang on Windows. Use `cmd /c` instead:

**Claude Desktop:**

```json
{
  "mcpServers": {
    "dpay": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@rakelabs/dpay-mcp"],
      "env": {
        "RPC_URL": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
        "CHAIN_ID": "1",
        "PRIVATE_KEY": "0x...",
        "ALLOWED_TOKENS": "ETH:0.1:0.01"
      }
    }
  }
}
```

**VS Code:**

```json
{
  "servers": {
    "dpay": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@rakelabs/dpay-mcp"],
      "env": {
        "RPC_URL": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
        "CHAIN_ID": "1",
        "PRIVATE_KEY": "0x...",
        "ALLOWED_TOKENS": "ETH:0.1:0.01"
      }
    }
  }
}
```

### Docker

```json
{
  "mcpServers": {
    "dpay": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "rakelabs/dpay-mcp"],
      "env": {
        "RPC_URL": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
        "CHAIN_ID": "1",
        "PRIVATE_KEY": "0x...",
        "ALLOWED_TOKENS": "ETH:0.1:0.01"
      }
    }
  }
}
```

### Other MCP Clients

Use `command: "npx"` with `args: ["-y", "@rakelabs/dpay-mcp"]` and pass env vars through your client config.

## Development

```bash
git clone https://github.com/programmaman/dpay-mcp.git
cd dpay-mcp
npm install

export RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
export CHAIN_ID=1
export PRIVATE_KEY=0x...
export ALLOWED_TOKENS=ETH:0.1:0.01

npm run dev
```

## Agent Prompt Examples

```
I want to do business on chain, what's your wallet address?
```

```
Send 0.01 ETH to 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 with a 1-day settlement window.
```

The agent handles the rest. Tool definitions describe every action — creating payments, checking status, settling, disputing, refunding. Just tell the agent what you need, or let it do what it wants.

## Tools

| Tool | Description | Use case |
|------|-------------|----------|
| `whoami` | Returns wallet address, chain ID, factory, and spending limits | Start of session |
| `eth_create_payment` | Creates an ETH escrow | Pay someone in ETH |
| `erc20_create_payment` | Creates an ERC20 escrow and handles approval | Pay someone in USDC or another token |
| `payment_info` | Reads on-chain payment state | Check current status |
| `raise_dispute` | Starts arbitration | Payment is disputed |
| `submit_evidence` | Publishes evidence to IPFS and submits it on-chain | Prove a case in arbitration |
| `settle` | Claims funds after the settlement window | You are the payee and time has passed |
| `refund` | Returns funds to the payer voluntarily | You are the payee and want to refund |

## Workflows

```text
Create  whoami -> eth_create_payment or erc20_create_payment
Settle  payment_info -> settle (payee only, after settlement window)
Dispute payment_info -> raise_dispute -> submit_evidence
Refund  payment_info -> refund (payee only)
```

## Configuration

Set these environment variables before starting the server.

### Required

- `RPC_URL`: EVM RPC endpoint
- `CHAIN_ID`: Chain ID. Use `1` for Ethereum mainnet.
- `ALLOWED_TOKENS`: Spending limits. Format described below.

### Optional

- `PRIVATE_KEY`: Wallet private key. Omit for a disposable wallet.
- `MIN_SETTLEMENT_WINDOW_SEC`: Minimum settlement window in seconds.
- `FACTORY_ADDRESS`: Payment factory contract address. Omit if the factory is known for your chain.
- `POLICY_WEBHOOK_URL`: URL for external compliance checks. Fail-closed.
- `POLICY_WEBHOOK_TOKEN`: Bearer token for the policy webhook.
- `EVIDENCE_IPFS_ENDPOINT`: Remote IPFS endpoint. Omit for in-process Helia.
- `EVIDENCE_IPFS_AUTH_TYPE`: Auth type: `bearer`, `basic`, or `none`.
- `EVIDENCE_IPFS_AUTH_TOKEN`: Token for bearer auth.
- `EVIDENCE_IPFS_USERNAME`: Username for basic auth.
- `EVIDENCE_IPFS_PASSWORD`: Password for basic auth.
- `EVIDENCE_IPFS_HEADERS`: Extra HTTP headers as JSON. Example: `{"network":"public"}`
- `EVIDENCE_IPFS_UPLOAD_FIELDS`: Multipart fields as JSON. Example: `{"network":"public"}`
- `EVIDENCE_IPFS_FILE_FIELD`: Multipart field name for the file blob.
- `EVIDENCE_IPFS_GATEWAYS`: Comma-separated IPFS gateway URLs for readable links.

### ALLOWED_TOKENS format

```bash
ALLOWED_TOKENS=ETH:0.1:0.01,0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:500:100
```

Each entry is `address:session_budget:max_per_tx`. Built-in aliases are `ETH` and `USDC`.

When `ALLOWED_TOKENS` is set, the server rejects transactions that:

- use a token not in the list
- exceed the per-transaction limit
- exceed the session budget

The server will not start without `ALLOWED_TOKENS`. This prevents an agent from spending without limits.

## Wallets

If you omit `PRIVATE_KEY`, the server creates a random wallet on first start. The key is saved to `~/.dpay-mcp/wallet-key`. Set `PRIVATE_KEY` later to reuse the same wallet.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start the server with tsx (hot reload) |
| `npm start` | Build and start from compiled JavaScript |
| `npm run inspector` | Open the MCP Inspector UI |

## Project Structure

```text
src/
  index.ts                   server startup and tool registration
  dpay-signer.ts             transaction signing and submission
  config-enforcer.ts         spending limit checks
  natural-language-converter.ts  ETH and ERC20 unit conversion
  evidence-client.ts         IPFS evidence publishing (worker thread bridge)
  evidence-worker.ts         Helia worker thread
  payment-store.ts           payment record persistence
  error-format.ts            revert data decoding
  policy-webhook.ts          external compliance check
test/                        tests
```

## License

Apache 2.0