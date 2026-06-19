import {ethers} from 'ethers';
import type {PreparedTx} from '@rakelabs/dpayments-sdk';
import {DPayments, getFactoryAddress} from '@rakelabs/dpayments-sdk';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface DPaySignerConfig {
  rpcUrl: string;
  /** An ethers Signer capable of sending transactions (Wallet, HDNodeWallet, etc.). */
  signer: ethers.Signer;
  /** The signer's public address. Needed by the SDK to fill callerWallet. */
  walletAddress: string;
  chainId: number;
}

export interface TxResult {
  txHash: string;
  gasUsed?: string;
  blockNumber?: number;
  status?: number;
  logs?: readonly ethers.Log[];
}

export interface PaymentCreated {
  txHash: string;
  paymentAddress: string;
  paymentId: string;
  grossAmountWei: string;
}

// ─── DPaySigner ───────────────────────────────────────────────────────────────

/**
 * Signs and submits Disputable Payment transactions via an ethers Wallet.
 *
 * Wraps the `@rakelabs/dpayments-sdk` — all "write" methods build a PreparedTx
 * via the SDK, then sign + submit through the provided Wallet.
 */
export class DPaySigner {
  readonly provider: ethers.JsonRpcProvider;
  readonly signer: ethers.Signer;
  readonly dpayments: DPayments;
  /** The PaymentFactory contract address for the configured chain. */
  readonly factoryAddress: string;
  /** The configured wallet address — cached to avoid redundant async getAddress() calls. */
  readonly walletAddress: string;

  /** Serial execution queue — guarantees broadcasts fire in order. */
  private txQueue: Promise<any> = Promise.resolve();

  /**
   * Fetch the current on-chain nonce for this wallet.
   * Always hits the RPC — no caching, no stale state, no poisoning.
   * `pending` includes unconfirmed txs, giving us back-to-back nonces.
   */
  private async allocateNonces(count: number): Promise<number> {
    return this.provider.getTransactionCount(this.walletAddress, 'pending');
  }

  constructor(config: DPaySignerConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId, {
      staticNetwork: true, // pin to the configured chain
    });
    // Defensively connect the signer — some Signer implementations (hardware wallets,
    // abstract signers) lack .connect(). Fall back to the raw signer if so.
    this.signer = typeof (config.signer as any).connect === 'function'
        ? (config.signer as any).connect(this.provider)
        : config.signer;
    this.walletAddress = config.walletAddress;

    const factoryAddress = process.env.FACTORY_ADDRESS ?? getFactoryAddress(config.chainId);
    if (!factoryAddress) {
      throw new Error(
        `No known factory deployment for chain ID ${config.chainId}. ` +
        `Set FACTORY_ADDRESS env var or check listDeployments().`,
      );
    }
    this.factoryAddress = factoryAddress;

    this.dpayments = new DPayments({
      chainId: config.chainId,
      factoryAddress,
      provider: this.provider,
      walletAddress: config.walletAddress,
    });
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /** Submits a single transaction. */
  private async signAndSend(tx: PreparedTx): Promise<TxResult> {
    const results = await this.signAndSendBatch([tx]);
    return results[0];
  }

  /** Submits multiple transactions back-to-back, then waits for all to mine. */
  private async signAndSendBatch(txs: PreparedTx[]): Promise<TxResult[]> {
    const currentQueue = this.txQueue;
    const txResponses: ethers.TransactionResponse[] = [];

    // 1. Broadcast phase (Serialized queue)
    this.txQueue = (async () => {
      await currentQueue.catch(() => {});
      const startNonce = await this.allocateNonces(txs.length);

      try {
        for (let i = 0; i < txs.length; i++) {
          const tx = txs[i];
          const response = await this.signer.sendTransaction({
            to: tx.to,
            data: tx.data,
            nonce: startNonce + i,
            value: tx.value && BigInt(tx.value) > 0n ? tx.value : undefined,
            chainId: tx.chainId,
          });
          txResponses.push(response);
        }
      } catch (err) {
        throw err;
      }
    })();

    await this.txQueue; // Wait for broadcasts to finish

    // 2. Mining phase — each tx gets its own independent 120s timeout
    const receipts = await Promise.all(
      txResponses.map(res => Promise.race([
        res.wait(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`tx ${res.hash} unconfirmed after 120s`)),
            120_000,
          ),
        ),
      ])),
    );

    // 3. Check and return
    return receipts.map((receipt, index) => {
      if (receipt?.status === 0) {
        throw new Error(`Transaction reverted on-chain: ${txResponses[index].hash}`);
      }
      return {
        txHash: txResponses[index].hash,
        gasUsed: receipt?.gasUsed?.toString(),
        blockNumber: receipt?.blockNumber,
        status: receipt?.status ?? undefined,
        logs: receipt?.logs,
      };
    });
  }

  // ─── Factory: create payment (ETH) ───────────────────────────────────────

  async createEthPayment(params: {
    payeeAddress: string;
    netAmountWei: bigint;
    settlementTimeUnixSec: bigint;
    paymentId?: string;
  }): Promise<PaymentCreated> {
    const result = await this.dpayments.factory.prepareCreateEthPayment(
      {
        netAmount: params.netAmountWei,
        payeeAddress: params.payeeAddress,
        settlementTimeUnixSec: params.settlementTimeUnixSec,
        paymentId: params.paymentId,
      },
    );
    const tx = await this.signAndSend(result.tx);

    // Predict the deterministic clone address off-chain using the cached wallet address
    const paymentAddress = await this.dpayments.factory.predictAddress(
      this.walletAddress,
      {
        id: result.paymentId,
        payee: params.payeeAddress,
        token: ethers.ZeroAddress,
        amount: params.netAmountWei,
        fee: result.fee,
        settlementTime: params.settlementTimeUnixSec,
      },
    );

    return {
      txHash: tx.txHash,
      paymentAddress,
      paymentId: result.paymentId,
      grossAmountWei: result.gross.toString(),
    };
  }

  // ─── Factory: create payment (ERC20) ─────────────────────────────────────

  async createErc20Payment(params: {
    tokenAddress: string;
    payeeAddress: string;
    netAmountWei: bigint;
    settlementTimeUnixSec: bigint;
    paymentId?: string;
  }): Promise<{
    approveTx: TxResult | undefined;
    createTx: TxResult;
    paymentId: string;
    grossAmountWei: string;
    predictedAddress: string;
  }> {
    const result = await this.dpayments.factory.prepareCreateErc20Payment(
      {
        tokenAddress: params.tokenAddress,
        netAmount: params.netAmountWei,
        payeeAddress: params.payeeAddress,
        settlementTimeUnixSec: params.settlementTimeUnixSec,
        paymentId: params.paymentId,
      },
    );

    // Read current allowance — skip approve if already sufficient
    const { allowance: currentAllowance } = await this.readApprovalStatus(
      params.tokenAddress, this.walletAddress, result.predictedAddress,
    );
    const needsApprove = BigInt(currentAllowance) < result.gross;

    // Collect the transactions we need to broadcast
    const txsToBroadcast: PreparedTx[] = [];
    if (needsApprove) txsToBroadcast.push(result.approveTx);
    txsToBroadcast.push(result.createTx);

    // Send them through the batched pipeline
    const txResults = await this.signAndSendBatch(txsToBroadcast);

    return {
      approveTx: needsApprove ? txResults[0] : undefined,
      createTx: needsApprove ? txResults[1] : txResults[0],
      paymentId: result.paymentId,
      grossAmountWei: result.gross.toString(),
      predictedAddress: result.predictedAddress,
    };
  }

  // ─── Bound payment: read (no signing) ─────────────────────────────────────

  async readPayment(paymentAddress: string) {
    const dPayment = this.dpayments.dPayment(paymentAddress);
    return dPayment.read();
  }

  // ─── Read ERC20 allowance + balance ──────────────────────────────────────
  //
  // TODO: Move into @rakelabs/dpayments-sdk PaymentReader as
  //       readErc20Allowance(token, owner, spender) so ABI defs live
  //       in the SDK, not here.
  // ──────────────────────────────────────────────────────────────────────────

  async readApprovalStatus(tokenAddress: string, ownerAddress: string, spenderAddress: string): Promise<{ allowance: string; balance: string }> {
    const erc20 = new ethers.Contract(
      tokenAddress,
      [
        'function allowance(address,address) view returns (uint256)',
        'function balanceOf(address) view returns (uint256)',
      ],
      this.provider,
    );
    const [allowance, balance] = await Promise.all([
      erc20.allowance(ownerAddress, spenderAddress),
      erc20.balanceOf(ownerAddress),
    ] as const);
    return {
      allowance: allowance.toString(),
      balance: balance.toString(),
    };
  }

  // ─── Bound payment: settle / claim after settlement time ──────────────────

  async settle(paymentAddress: string): Promise<TxResult> {
    const dPayment = this.dpayments.dPayment(paymentAddress);
    return this.signAndSend(dPayment.settle());
  }

  // ─── Bound payment: voluntary refund ──────────────────────────────────────

  async voluntaryRefund(paymentAddress: string): Promise<TxResult> {
    const dPayment = this.dpayments.dPayment(paymentAddress);
    return this.signAndSend(dPayment.voluntaryRefund());
  }

  // ─── Bound payment: raise dispute ─────────────────────────────────────────

  async raiseDispute(
    paymentAddress: string,
  ): Promise<TxResult & { arbFeeWei: string }> {
    const dPayment = this.dpayments.dPayment(paymentAddress);
    const result = await dPayment.prepareRaiseDispute();
    return {
      ...(await this.signAndSend(result.tx)),
      arbFeeWei: result.arbFeeWei.toString(),
    };
  }

  // ─── Bound payment: submit evidence ───────────────────────────────────────

  async submitEvidence(
    paymentAddress: string,
    evidenceUri: string,
  ): Promise<TxResult> {
    const dPayment = this.dpayments.dPayment(paymentAddress);
    return this.signAndSend(dPayment.submitEvidence(evidenceUri));
  }

  // ─── Bound payment: appeal a ruling ───────────────────────────────────────

  async appeal(
    paymentAddress: string,
    extraData?: string,
  ): Promise<TxResult & { appealFeeWei: string }> {
    const dPayment = this.dpayments.dPayment(paymentAddress);
    const result = await dPayment.prepareAppeal(extraData);
    return {
      ...(await this.signAndSend(result.tx)),
      appealFeeWei: result.appealFeeWei.toString(),
    };
  }

  // ─── ERC20 approval ──────────────────────────────────────────────────────

  async erc20Approve(
    tokenAddress: string,
    spenderAddress: string,
    amountWei: bigint,
  ): Promise<TxResult> {
    return this.signAndSend(
      this.dpayments.factory.erc20Approve({
        tokenAddress,
        spenderAddress,
        amount: amountWei,
      }),
    );
  }
}