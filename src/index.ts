import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ethers } from 'ethers';
import { z } from 'zod';
import { DPaySigner } from './dpay-signer.js';
import { NaturalLanguageToChainConverter } from './natural-language-converter.js';
import { PaymentStore } from './payment-store.js';
import { ConfigEnforcer } from './config-enforcer.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { publishEvidence, warmUp, closeWorker } from './evidence-client.js';
import { formatRevert } from './error-format.js';
import { checkPolicy } from './policy-webhook.js';

// ─── Stderr logger ─────────────────────────────────────────────────────────
const logger = {
  info: (msg: string) => process.stderr.write(`[dpay-mcp] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[dpay-mcp] ⚠ ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[dpay-mcp] ✗ ${msg}\n`),
};

// ─── Evidence publisher ────────────────────────────────────────────────
// Helia runs in a dedicated worker thread.  The evidence-client module spawns
// the Worker on import — startup is instant and never blocks MCP requests.

// ─── Tool schemas ──────────────────────────────────────────────────────────

const PingSchema = z.object({});

/** Trims whitespace from address strings to handle LLM-produced padding. */
const AddressString = z.string().transform(v => v.trim());

const CoercedString = z.union([z.string(), z.number()]).transform(v => String(v));

const CreatePaymentSchema = z.object({
  payeeAddress: AddressString.describe('The recipient address'),
  etherAmount: CoercedString.describe('Amount in ETH. Example: "0.001" for 0.001 ETH.'),
  settlementWindowSec: CoercedString.describe('Settlement window in seconds from now. Example: "86400" for 1 day. The server computes the absolute timestamp from the latest block.'),
});

const PaymentAddressSchema = z.object({
  paymentAddress: AddressString.describe('The DisputablePayment contract address'),
});

const SubmitEvidenceSchema = z.object({
  paymentAddress: AddressString.describe('The DisputablePayment contract address'),
  argument: z.string().optional().describe('A factual account of what happened with this payment, from your perspective. Jurors will read this to understand the context of the dispute.'),
});

const CreateErc20PaymentSchema = z.object({
  tokenAddress: AddressString.describe('The ERC20 token contract address'),
  payeeAddress: AddressString.describe('The recipient address'),
  tokenAmount: CoercedString.describe('Amount in token units. Example: "1" for 1 USDC.'),
  settlementWindowSec: CoercedString.describe('Settlement window in seconds from now. Example: "86400" for 1 day. The server computes the absolute timestamp from the latest block.'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Env ─────────────────────────────────────────────────────────────────
  const rpcUrl = process.env.RPC_URL;
  const rawChainId = process.env.CHAIN_ID;
  const explicitPrivateKey = process.env.PRIVATE_KEY; // optional — omit for self-generated

  if (!rpcUrl) {
    logger.error('Missing RPC_URL environment variable');
    process.exit(1);
  }
  if (!rawChainId) {
    logger.error('Missing CHAIN_ID environment variable');
    process.exit(1);
  }

  const chainId = Number(rawChainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    logger.error(`CHAIN_ID must be a positive integer, got: ${rawChainId}`);
    process.exit(1);
  }

  // ── Wallet ──────────────────────────────────────────────────────────────
  const wallet = explicitPrivateKey
      ? new ethers.Wallet(explicitPrivateKey)
      : ethers.Wallet.createRandom();

  if (explicitPrivateKey) {
    logger.info(`wallet=${wallet.address}`);
  } else {
    logger.info(`wallet=${wallet.address} (auto-generated)`);

    // Persist the key to disk so the human can recover it later.
    // The key file is never exposed through any MCP tool or resource.
    const keyDir = join(homedir(), '.dpay-mcp');
    const keyPath = join(keyDir, 'wallet-key');
    try {
      mkdirSync(keyDir, { recursive: true });
      writeFileSync(keyPath, wallet.privateKey, { mode: 0o600 });
      logger.info(`wallet key saved to ${keyPath}`);
      logger.info(`  → Set PRIVATE_KEY env var on next server start to reuse this wallet`);
    } catch (err) {
      logger.warn(`could not save wallet key to ${keyPath}: ${String(err)}`);
      logger.warn(`  → SAVE THIS KEY TO REUSE THIS WALLET: ${wallet.privateKey}`);
    }
  }

  // ── Signer ──────────────────────────────────────────────────────────────
  const signer = new DPaySigner({ signer: wallet, walletAddress: wallet.address, rpcUrl, chainId });
  const converter = new NaturalLanguageToChainConverter(signer.provider);
  const store = new PaymentStore();
  logger.info(`connected chainId=${chainId} factory=${signer.factoryAddress}`);

  // ── Server config ───────────────────────────────────────────────────────
  const enforcer = ConfigEnforcer.fromEnv(converter);

  // ── Server ──────────────────────────────────────────────────────────────
  const server = new McpServer(
      {
        name: 'dpay-mcp',
        version: '0.1.0',
      },
      {
        instructions: [
          'This MCP server enables you to sign, submit, and dispute Disputable Payment transactions.',
          'Disputable Payments are programmable with settlement windows.',
          `Your connected wallet is ${wallet.address} on chain ${chainId}.`,
          '',
          'Available Roles:',
          '  Payer — when you are the wallet that sends funds (creates the payment contract).',
          '  Payee — when you are the wallet that receives funds (the recipient).',
          '',
          'WORKFLOWS (pick one):',
          '  CREATE: eth_create_payment (ETH) or erc20_create_payment (ERC20) → payment_info',
          '  SETTLE: settle — only the PAYEE calls this, after delivering what was agreed.',
          '  REFUND: refund — only the PAYEE calls this, to voluntarily send funds back.',
          '  DISPUTE: raise_dispute → submit_evidence → DONE (stop here)',
          '',
          'RULES:',
          '- Your wallet is the PAYER when creating a payment.',
          '- Your wallet is the PAYEE when settling or refunding.',
          '- Only the PAYEE can call settle or refund.',
          '- Do NOT call settle or refund if the payment status is DISPUTED.',
        ].join('\n'),
      },
  );

  // ── Helper: map on-chain number state to string ───────────────────────
  const STATE_NAMES: Record<number, string> = { 0: 'PAID', 1: 'SETTLED', 2: 'DISPUTED', 3: 'RESOLVED' };

  // ── Resources ────────────────────────────────────────────────────────────
  server.registerResource(
      'payment',
      new ResourceTemplate('dpay://payments/{paymentAddress}', {
        list: () => ({
          resources: store.list().map(r => ({
            uri: `dpay://payments/${r.paymentAddress}`,
            name: `${r.paymentAddress.slice(0, 10)}… (${r.state})`,
          })),
        }),
      }),
      { title: 'Payment Record', description: 'Cached payment state and metadata', mimeType: 'application/json' },
      (uri, { paymentAddress }) => {
        const address = Array.isArray(paymentAddress) ? paymentAddress[0] : paymentAddress;
        return {
          contents: [{
            uri: uri.href,
            text: JSON.stringify(store.get(address) ?? { error: 'not found' }, null, 2),
          }],
        };
      },
  );

  server.registerResource(
      'payment-list',
      'dpay://payments',
      { title: 'All Payments', description: 'List of all tracked payments', mimeType: 'application/json' },
      (uri) => ({
        contents: [{
          uri: uri.href,
          text: JSON.stringify(store.list(), null, 2),
        }],
      }),
  );

  // ── Tool: whoami ─────────────────────────────────────────────────
  server.registerTool(
      'whoami',
      {
        description:
            'Use this to discover which wallet and chain you are operating on. ' +
            'Returns your wallet address, chain ID, the payment factory address, ' +
            'and spending limits.  ' +
            'Usage: { }',
        inputSchema: PingSchema,
      },
      async () => {
        const limits = await enforcer.humanReadableLimits();
        return {
          content: [{ type: 'text', text: JSON.stringify({
              status: 'ok',
              yourWallet: wallet.address,
              chainId,
              factory: signer.factoryAddress,
              spendingLimits: limits,
              minSettlementWindowSec: enforcer.minSettlementWindowSec || undefined,
            }) }],
        };
      },
  );

  // ── Tool: eth_create_payment ────────────────────────────────────────────
  server.registerTool(
      'eth_create_payment',
      {
        description:
            'Creates an ETH payment contract. ONLY for ETH — do NOT use for USDC or other ERC20 tokens. ' +
            'Usage: { payeeAddress: <RECIPIENT_ADDRESS>, etherAmount: <AMOUNT>, settlementWindowSec: <SECONDS> }',
        inputSchema: CreatePaymentSchema,
      },
        async (args: Record<string, unknown>) => {
        try {
          const parsed = CreatePaymentSchema.parse(args);
          const policy = await checkPolicy('eth_create_payment', args, wallet.address, chainId);
          if (!policy.allowed) return { content: [{ type: 'text', text: `Policy denied: ${policy.reason}` }], isError: true };
          const net = converter.ethToWei(parsed.etherAmount);
          const { blockNumber, blockTs, settlementTimeUnixSec } = await converter.settlementTimestamp(parsed.settlementWindowSec);
          await enforcer.validate({ netAmountWei: net, settlementTimeUnixSec }, ethers.ZeroAddress);
          logger.info(`eth_create_payment: block=${blockNumber} ts=${blockTs} settlement=${settlementTimeUnixSec}`);

          const result = await signer.createEthPayment({
            payeeAddress: parsed.payeeAddress,
            netAmountWei: net,
            settlementTimeUnixSec,
          });

          enforcer.recordSpend(net, ethers.ZeroAddress);

          await store.upsert(result.paymentAddress, {
            chainId,
            payee: parsed.payeeAddress,
            etherAmount: parsed.etherAmount,
            state: 'PAID',
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'created',
                  paymentId: result.paymentId,
                  paymentAddress: result.paymentAddress,
                  grossAmountWei: result.grossAmountWei,
                  txHash: result.txHash,
                }, null, 2),
              },
            ],
          };
        } catch (error: unknown) {
          return { content: [{ type: 'text', text: `create_payment failed: ${formatRevert(error)}` }], isError: true };
        }
      },
  );

  // ── Tool: payment_info ──────────────────────────────────────────────────
  server.registerTool(
      'payment_info',
      {
        description: 'Returns the full on-chain state for a payment: current state, payer, payee, amount, token, settlement deadline. Usage: { paymentAddress: <PAYMENT_ADDRESS> }',
        inputSchema: PaymentAddressSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const parsed = PaymentAddressSchema.parse(args);
          const info = await signer.readPayment(parsed.paymentAddress);

          // Auto-refresh cached state from on-chain
          const stateName = STATE_NAMES[Number(info.state)] ?? 'UNKNOWN';
          await store.upsert(parsed.paymentAddress, { state: stateName });

          return {
            content: [{ type: 'text', text: JSON.stringify(info, (_k: string, v: unknown) => typeof v === 'bigint' ? v.toString() : v, 2) }],
          };
        } catch (error: unknown) {
          return { content: [{ type: 'text', text: `payment_info failed: ${formatRevert(error)}` }], isError: true };
        }
      },
  );

  // ── Tool: raise_dispute ─────────────────────────────────────────────────
  server.registerTool(
      'raise_dispute',
      {
        description: 'Raises a Kleros dispute (on-chain arbitration). Only valid when payment is PAID and settlement time has NOT passed. Usage: { paymentAddress: <PAYMENT_ADDRESS> }',
        inputSchema: PaymentAddressSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const parsed = PaymentAddressSchema.parse(args);
          const policy = await checkPolicy('raise_dispute', args, wallet.address, chainId);
          if (!policy.allowed) return { content: [{ type: 'text', text: `Policy denied: ${policy.reason}` }], isError: true };
          const result = await signer.raiseDispute(parsed.paymentAddress);

          await store.upsert(parsed.paymentAddress, { state: 'DISPUTED' });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  txHash: result.txHash,
                  arbFeeWei: result.arbFeeWei,
                  gasUsed: result.gasUsed,
                  blockNumber: result.blockNumber,
                }, null, 2),
              },
            ],
          };
        } catch (error: unknown) {
          return { content: [{ type: 'text', text: `raise_dispute failed: ${formatRevert(error)}` }], isError: true };
        }
      },
  );

  // ── Tool: submit_evidence ───────────────────────────────────────────────
  server.registerTool(
      'submit_evidence',
      {
        description: 'Creates an evidence record and submits it to the dispute on-chain. Only valid when payment is DISPUTED. Usage: { paymentAddress: <PAYMENT_ADDRESS>, argument: <ARGUMENT> }',
        inputSchema: SubmitEvidenceSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const parsed = SubmitEvidenceSchema.parse(args);
          const policy = await checkPolicy('submit_evidence', args, wallet.address, chainId);
          if (!policy.allowed) return { content: [{ type: 'text', text: `Policy denied: ${policy.reason}` }], isError: true };
          const argument = parsed.argument ?? 'No additional details provided.';
          logger.info(`submit_evidence: address=${parsed.paymentAddress}${parsed.argument ? ` argument=${parsed.argument}` : ''}`);

          // 1. Publish evidence document via the evidence publisher (Helia IPFS)
          const { uri, cid, selfHash } = await publishEvidence(
            `Dispute evidence — ${parsed.paymentAddress}`,
            argument,
          );
          logger.info(`submit_evidence: published evidence doc → ${uri}`);

          // 2. Store the URI locally
          const existing = store.get(parsed.paymentAddress);
          await store.upsert(parsed.paymentAddress, {
            evidenceUris: [...(existing?.evidenceUris ?? []), uri],
          });

          // 3. Submit on-chain
          const result = await signer.submitEvidence(parsed.paymentAddress, uri);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'submitted',
                  evidenceUri: uri,
                  evidenceCid: cid,
                  selfHash,
                  txHash: result.txHash,
                  gasUsed: result.gasUsed,
                  blockNumber: result.blockNumber,
                }, null, 2),
              },
            ],
          };
        } catch (error: unknown) {
          return { content: [{ type: 'text', text: `submit_evidence failed: ${formatRevert(error)}` }], isError: true };
        }
      },
  );

  // ── Tool: settle ────────────────────────────────────────────────────────
  server.registerTool(
      'settle',
      {
        description: 'Settle or claim the payment funds to your wallet after the settlement window has passed. Only the PAYEE can call this. Usage: { paymentAddress: <PAYMENT_ADDRESS> }',
        inputSchema: PaymentAddressSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const parsed = PaymentAddressSchema.parse(args);
          const policy = await checkPolicy('settle', args, wallet.address, chainId);
          if (!policy.allowed) return { content: [{ type: 'text', text: `Policy denied: ${policy.reason}` }], isError: true };
          logger.info(`settle: paymentAddress=${parsed.paymentAddress}`);
          logger.info(`settle: signer wallet=${wallet.address}`);
          const result = await signer.settle(parsed.paymentAddress);
          logger.info(`settle: txHash=${result.txHash} block=${result.blockNumber} gasUsed=${result.gasUsed}`);

          await store.upsert(parsed.paymentAddress, { state: 'SETTLED' });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  txHash: result.txHash,
                  gasUsed: result.gasUsed,
                  blockNumber: result.blockNumber,
                }, null, 2),
              },
            ],
          };
        } catch (error: unknown) {
          return { content: [{ type: 'text', text: `settle failed: ${formatRevert(error)}` }], isError: true };
        }
      },
  );

  // ── Tool: refund ────────────────────────────────────────────────────────
  server.registerTool(
      'refund',
      {
        description: 'Voluntarily send the funds back to the payer. Only the PAYEE can call this. Only valid when payment is in PAID status. Usage: { paymentAddress: <PAYMENT_ADDRESS> }',
        inputSchema: PaymentAddressSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const parsed = PaymentAddressSchema.parse(args);
          const policy = await checkPolicy('refund', args, wallet.address, chainId);
          if (!policy.allowed) return { content: [{ type: 'text', text: `Policy denied: ${policy.reason}` }], isError: true };
          const result = await signer.voluntaryRefund(parsed.paymentAddress);

          await store.upsert(parsed.paymentAddress, { state: 'SETTLED' });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  txHash: result.txHash,
                  gasUsed: result.gasUsed,
                  blockNumber: result.blockNumber,
                }, null, 2),
              },
            ],
          };
        } catch (error: unknown) {
          return { content: [{ type: 'text', text: `refund failed: ${formatRevert(error)}` }], isError: true };
        }
      },
  );


  // ── Tool: erc20_create_payment ─────────────────────────────────────────
  server.registerTool(
      'erc20_create_payment',
      {
        description:
            'Creates an ERC20 payment contract. Handles token approval + deployment in one atomic step. ' +
            'ONLY for ERC20 tokens — do NOT use for ETH. ' +
            'Usage: { tokenAddress: <TOKEN_ADDRESS>, payeeAddress: <RECIPIENT_ADDRESS>, tokenAmount: <AMOUNT>, settlementWindowSec: <SECONDS> }',
        inputSchema: CreateErc20PaymentSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const parsed = CreateErc20PaymentSchema.parse(args);
          const policy = await checkPolicy('erc20_create_payment', args, wallet.address, chainId);
          if (!policy.allowed) return { content: [{ type: 'text', text: `Policy denied: ${policy.reason}` }], isError: true };
          const net = await converter.erc20ToBaseUnits(parsed.tokenAddress, parsed.tokenAmount);
          const { blockNumber, blockTs, settlementTimeUnixSec } = await converter.settlementTimestamp(parsed.settlementWindowSec);
          await enforcer.validate({ netAmountWei: net, settlementTimeUnixSec }, parsed.tokenAddress);
          logger.info(`erc20_create_payment: block=${blockNumber} ts=${blockTs} settlement=${settlementTimeUnixSec}`);

          const result = await signer.createErc20Payment({
            tokenAddress: parsed.tokenAddress,
            payeeAddress: parsed.payeeAddress,
            netAmountWei: net,
            settlementTimeUnixSec,
          });

          enforcer.recordSpend(net, parsed.tokenAddress);

          await store.upsert(result.predictedAddress, {
            chainId,
            payee: parsed.payeeAddress,
            tokenAddress: parsed.tokenAddress,
            tokenAmount: parsed.tokenAmount,
            state: 'PAID',
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'created',
                  paymentId: result.paymentId,
                  paymentAddress: result.predictedAddress,
                  grossAmountWei: result.grossAmountWei,
                  tokenApprovalTxHash: result.approveTx?.txHash ?? null,
                  createTxHash: result.createTx.txHash,
                }, null, 2),
              },
            ],
          };
        } catch (error: unknown) {
          return { content: [{ type: 'text', text: `create_erc20_payment failed: ${formatRevert(error)}` }], isError: true };
        }
      },
  );

  // ── Transport ───────────────────────────────────────────────────────────
  const transport = new StdioServerTransport();

  // Catch transport-level errors to prevent silent crashes
  transport.onerror = (error) => {
    logger.error(`Transport error: ${error.message}`);
  };

  // Catch protocol-level errors (malformed JSON-RPC, etc.)
  server.server.onerror = (error: Error) => {
    logger.error(`Server error: ${error.message}`);
  };

  await server.connect(transport);
  logger.info('dpay-mcp server running on stdio');

  // Fire up Helia in the worker thread so it's ready by the time the
  // LLM chats through a few turns and calls submit_evidence.
  warmUp();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.warn(`Received ${signal}. Shutting down...`);
    try {
      await server.close();
      await closeWorker();
      process.exit(0);
    } catch (err) {
      logger.error(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

process.on('unhandledRejection', (reason: unknown) => {
  logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('Fatal server error: ' + message);
  process.exit(1);
});