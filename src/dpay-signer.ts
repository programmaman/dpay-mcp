import { ethers, NonceManager } from 'ethers';
import type { PreparedTx } from '@rakelabs/dpayments-sdk';
import { DPayments, getFactoryAddress } from '@rakelabs/dpayments-sdk';

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
  private txQueue: Promise<unknown> = Promise.resolve();

  constructor(config: DPaySignerConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId, {
      staticNetwork: true, // pin to the configured chain
    });

    // Defensively connect the signer, then wrap it in the NonceManager to
    // guarantee sequential nonces for back-to-back rapid broadcasts.
    const connectedSigner = 'connect' in config.signer && typeof config.signer.connect === 'function'
        ? config.signer.connect(this.provider)
        : config.signer;

    this.signer = new NonceManager(connectedSigner);
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

  // ─── Execution Engine ──────────────────────────────────────────────────────

  /**
   * Locks the queue, runs any necessary on-chain checks, broadcasts the txs,
   * and immediately releases the lock BEFORE waiting for mining to allow max throughput.
   */
  private async runInQueue<T>(
      buildAndBroadcast: () => Promise<{ responses: ethers.TransactionResponse[], data: T }>
  ): Promise<{ receipts: TxResult[], data: T }> {
    const currentQueue = this.txQueue;

    // 1. THE LOCK: State reads and broadcasts happen strictly one-at-a-time
    const broadcastPromise = (async () => {
      await currentQueue.catch(() => {});

      try {
        return await buildAndBroadcast();
      } catch (error) {
        if (this.signer instanceof NonceManager) {
          this.signer.reset();
        }
        throw error;
      }
    })();

    // CRITICAL: chain the next caller onto this broadcast so the queue stays alive.
    this.txQueue = broadcastPromise;

    const { responses: broadcastResponses, data: extraData } = await broadcastPromise;

    // 2. CONCURRENT MINING: Wait for blocks asynchronously
    const receipts = await Promise.all(
        broadcastResponses.map(res => Promise.race([
          res.wait(),
          new Promise<never>((_, reject) =>
              setTimeout(() => {
                // NO RESET HERE. A timeout implies a mempool drop, not corrupted local logic.
                // Requires application-level intervention to bump gas.
                reject(new Error(`tx ${res.hash} unconfirmed after 120s`));
              }, 120_000)
          ),
        ])),
    );

    // 3. Format and return results
    const formattedReceipts = receipts.map((receipt, index) => {
      if (receipt?.status === 0) {
        throw new Error(`Transaction reverted on-chain: ${broadcastResponses[index].hash}`);
      }
      return {
        txHash: broadcastResponses[index].hash,
        gasUsed: receipt?.gasUsed?.toString(),
        blockNumber: receipt?.blockNumber,
        status: receipt?.status ?? undefined,
        logs: receipt?.logs,
      };
    });

    return { receipts: formattedReceipts, data: extraData };
  }

  /** Submits a single transaction using the queue engine. */
  private async signAndSend(tx: PreparedTx): Promise<TxResult> {
    const { receipts } = await this.runInQueue(async () => {
      const response = await this.signer.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value && BigInt(tx.value) > 0n ? tx.value : undefined,
        chainId: tx.chainId,
      });
      return { responses: [response], data: null };
    });
    return receipts[0];
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

    // Use the queue engine to lock the allowance check AND the broadcast together
    const { receipts, data: { needsApprove } } = await this.runInQueue(async () => {

      const { allowance: currentAllowance } = await this.readApprovalStatus(
          params.tokenAddress, this.walletAddress, result.predictedAddress,
      );
      const needsApprove = BigInt(currentAllowance) < result.gross;

      const txsToBroadcast: PreparedTx[] = [];
      if (needsApprove) txsToBroadcast.push(result.approveTx);
      txsToBroadcast.push(result.createTx);

      const responses: ethers.TransactionResponse[] = [];
      for (const tx of txsToBroadcast) {
        responses.push(await this.signer.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value && BigInt(tx.value) > 0n ? tx.value : undefined,
          chainId: tx.chainId,
        }));
      }

      return { responses, data: { needsApprove } };
    });

    return {
      approveTx: needsApprove ? receipts[0] : undefined,
      createTx: needsApprove ? receipts[1] : receipts[0],
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
      await erc20.allowance(ownerAddress, spenderAddress) as Promise<bigint>,
      await erc20.balanceOf(ownerAddress) as Promise<bigint>,
    ]);
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

}