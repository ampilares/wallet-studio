import { randomUUID } from "node:crypto";
import path from "node:path";
import { withFileLock } from "../utils/fileLock.js";
import { assertBundleChain, hasSubmissionEvidence, isMockAction } from "./transactionSafety.js";
import { keccak256, type Hex } from "viem";
import type { AppConfig } from "../config.js";
import type { RpcManager } from "../chain/RpcManager.js";
import type { GasManager } from "../chain/GasManager.js";
import type { SequencerClient } from "../chain/SequencerClient.js";
import { SubmissionMetrics } from "../chain/SubmissionMetrics.js";
import type {
  BundleRepository,
  TransactionRepository,
} from "../database/repositories.js";
import type { WalletManager } from "../wallet/WalletManager.js";
import type { NonceManager } from "../wallet/NonceManager.js";
import type { Bundle, BundleAction, RecordedTransaction, TxLifecycleStatus } from "../types.js";
import type { Simulator } from "../simulation/Simulator.js";
import { mapPool } from "../utils/concurrency.js";

function classifyError(err: unknown): TxLifecycleStatus {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("nonce")) return "NONCE_ERROR";
  if (msg.includes("revert")) return "REVERTED";
  if (msg.includes("insufficient funds") || msg.includes("intrinsic gas") || msg.includes("gas required exceeds")) return "INSUFFICIENT_GAS";
  if (msg.includes("timeout")) return "TIMEOUT";
  return "SUBMISSION_FAILED";
}

export class ExecutionEngine {
  readonly metrics = new SubmissionMetrics();

  constructor(
    private readonly config: AppConfig,
    private readonly rpc: RpcManager,
    private readonly gas: GasManager,
    private readonly wallets: Pick<WalletManager, "getAccount">,
    private readonly nonces: NonceManager,
    private readonly simulator: Simulator,
    private readonly bundles: BundleRepository,
    private readonly txs: TransactionRepository,
    private readonly sequencer?: SequencerClient,
    private readonly localPreparedGas?: ReadonlyMap<string, bigint>,
  ) {}

  async executeBundle(bundleId: string): Promise<Bundle> {
    return withFileLock(path.resolve(this.config.dataDir, ".execution.lock"),
      () => this.executeLocked(bundleId), 0);
  }

  private async executeLocked(bundleId: string): Promise<Bundle> {
    if (this.localPreparedGas && this.config.network !== "local") throw new Error("Prepared batch gas is restricted to the local test chain");
    const bundle = await this.require(bundleId);
    if (bundle.status === "CANCELLED") {
      throw new Error("Bundle is cancelled");
    }

    if (bundle.actions.length === 0) {
      throw new Error("No actions");
    }

    if (this.config.mode === "live" && bundle.mode === "live" && bundle.actions.some(isMockAction)) {
      throw new Error("Mock DEX actions are forbidden in live mode");
    }
    await this.reconcileActions(bundle);
    // An ambiguous prior submission blocks further sends until its receipt is known.
    if (bundle.actions.some((a) => hasSubmissionEvidence(a) &&
      !["CONFIRMED", "REVERTED", "CANCELLED"].includes(a.status))) {
      await this.bundles.save(bundle);
      return this.finalize(bundleId);
    }
    this.metrics.reset();

    const report = await this.simulator.simulateBundle(bundle);
    if (!report.ok) {
      bundle.status = "SIMULATION_FAILED";
      await this.bundles.save(bundle);
      throw new Error(
        `Simulation failed:\n${report.issues
          .filter((i) => i.severity === "error")
          .map((i) => `- ${i.message}`)
          .join("\n")}`,
      );
    }

    const fees = await this.gas.getGasPrice();
    const maxFee =
      bundle.gasPlan.maxFeePerGas != null
        ? BigInt(bundle.gasPlan.maxFeePerGas)
        : fees.maxFeePerGas;
    const maxPriority =
      bundle.gasPlan.maxPriorityFeePerGas != null
        ? BigInt(bundle.gasPlan.maxPriorityFeePerGas)
        : fees.maxPriorityFeePerGas;

    await mapPool(bundle.actions, this.config.maxConcurrency, async (action) => {
      await this.executeAction(bundle, action, maxFee, maxPriority);
    });

    return this.finalize(bundleId);
  }

  getLastMetrics() {
    return this.metrics.snapshot();
  }

  private async executeAction(
    bundle: Bundle,
    action: BundleAction,
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint,
  ): Promise<void> {
    if (action.status === "CONFIRMED" || action.status === "CANCELLED" || hasSubmissionEvidence(action)) return;

    const record: RecordedTransaction = {
      id: randomUUID(),
      bundleId: bundle.id,
      actionId: action.id,
      wallet: action.walletAddress,
      actionType: action.type,
      amount: action.valueWei,
      status: "CREATED",
      timestamp: new Date().toISOString(),
    };
    await this.txs.append(record);

    if (this.config.mode === "simulation" || bundle.mode === "simulation") {
      action.status = "CONFIRMED";
      action.submittedAt = new Date().toISOString();
      action.confirmedAt = new Date().toISOString();
      action.gasUsed = "180000";
      action.submitLatencyMs = 0;
      action.confirmLatencyMs = 0;
      this.metrics.record({
        actionId: action.id,
        wallet: action.walletAddress,
        submitLatencyMs: 0,
        confirmLatencyMs: 0,
        ok: true,
      });
      await this.txs.update(record.id, {
        status: "CONFIRMED",
        gasUsed: action.gasUsed,
      });
      await this.bundles.save(bundle);
      return;
    }

    if (!action.target || !action.calldata) {
      action.status = "SUBMISSION_FAILED";
      action.error = "Missing target/calldata";
      this.metrics.record({
        actionId: action.id,
        wallet: action.walletAddress,
        submitLatencyMs: 0,
        ok: false,
        error: action.error,
      });
      await this.txs.update(record.id, { status: action.status, error: action.error });
      await this.bundles.save(bundle);
      return;
    }

    let nonce: number | undefined;
    let broadcastAttempted = false;
    const submitStarted = Date.now();
    try {
      const account = await this.wallets.getAccount(action.walletAddress);
      const walletClient = this.rpc.createWalletClient(account);
      nonce = await this.nonces.reserveNonce(action.walletAddress);
      action.nonce = nonce;

      const estimated = this.localPreparedGas?.get(action.id) ?? await this.rpc.getPublicClient().estimateGas({
        account,
        to: action.target,
        data: action.calldata,
        value: BigInt(action.valueWei ?? "0"),
      });
      const gas = this.gas.applyBuffer(estimated, bundle.gasPlan);

      const request = await walletClient.prepareTransactionRequest({
        account, to: action.target, data: action.calldata,
        value: BigInt(action.valueWei ?? "0"), nonce, gas,
        maxFeePerGas, maxPriorityFeePerGas, chain: this.rpc.chain,
      });
      const signed = await walletClient.signTransaction(request) as Hex;
      const hash = keccak256(signed);
      // Persist the locally computed hash and nonce before the first network send.
      // Even a lost response or process crash can now be reconciled without replay.
      action.txHash = hash;
      action.status = "SIGNED";
      await this.bundles.save(bundle);
      await this.txs.update(record.id, { status: "SIGNED", nonce, txHash: hash });
      broadcastAttempted = true;
      const returnedHash = this.config.useSequencer && this.sequencer
        ? await this.sequencer.sendRawTransaction(signed)
        : await this.rpc.getPublicClient().sendRawTransaction({ serializedTransaction: signed });
      if (returnedHash.toLowerCase() !== hash.toLowerCase()) {
        throw new Error("RPC returned a transaction hash that differs from the locally signed transaction");
      }

      const submitLatencyMs = Date.now() - submitStarted;
      action.submitLatencyMs = submitLatencyMs;
      action.txHash = hash;
      action.status = "SUBMITTED";
      action.submittedAt = new Date().toISOString();
      await this.bundles.save(bundle);
      await this.nonces.markNonceSubmitted(action.walletAddress, nonce);
      await this.txs.update(record.id, {
        status: "SUBMITTED",
        txHash: hash,
        nonce,
      });

      const confirmStarted = Date.now();
      const receipt = await this.rpc.getPublicClient().waitForTransactionReceipt({
        hash,
        timeout: 120_000,
      });
      const confirmLatencyMs = Date.now() - confirmStarted;
      action.confirmLatencyMs = confirmLatencyMs;

      if (receipt.status === "reverted") {
        action.status = "REVERTED";
        action.error = "Transaction reverted";
        this.metrics.record({
          actionId: action.id,
          wallet: action.walletAddress,
          submitLatencyMs,
          confirmLatencyMs,
          ok: false,
          error: action.error,
        });
      } else {
        action.status = "CONFIRMED";
        action.confirmedAt = new Date().toISOString();
        action.blockNumber = receipt.blockNumber.toString();
        action.gasUsed = receipt.gasUsed.toString();
        this.metrics.record({
          actionId: action.id,
          wallet: action.walletAddress,
          submitLatencyMs,
          confirmLatencyMs,
          ok: true,
        });
      }
      await this.txs.update(record.id, {
        status: action.status,
        gasUsed: action.gasUsed,
        blockNumber: action.blockNumber,
        error: action.error,
      });
    } catch (err) {
      if (!broadcastAttempted && !action.txHash) {
        if (nonce !== undefined) await this.nonces.releaseNonce(action.walletAddress, nonce);
        action.nonce = undefined;
        action.status = classifyError(err);
      } else {
        action.status = action.txHash ? "SUBMITTED" : "SIGNED";
      }
      action.error = err instanceof Error ? err.message : String(err);
      action.submitLatencyMs = Date.now() - submitStarted;
      this.metrics.record({
        actionId: action.id,
        wallet: action.walletAddress,
        submitLatencyMs: action.submitLatencyMs,
        ok: false,
        error: action.error,
      });
      await this.txs.update(record.id, {
        status: action.status,
        error: action.error,
        nonce,
      });
    }

    await this.bundles.save(bundle);
  }

  async retryFailed(bundleId: string): Promise<Bundle> {
    return this.executeBundle(bundleId);
  }

  async retryPending(bundleId: string): Promise<Bundle> {
    return this.executeBundle(bundleId);
  }

  async resumeBundle(bundleId: string): Promise<Bundle> {
    return this.executeBundle(bundleId);
  }

  private async reconcileActions(bundle: Bundle): Promise<void> {
    for (const action of bundle.actions) {
      if (!action.txHash || action.status === "CONFIRMED" || action.status === "CANCELLED") continue;
      try {
        const receipt = await this.rpc.getPublicClient().getTransactionReceipt({ hash: action.txHash });
        action.status = receipt.status === "reverted" ? "REVERTED" : "CONFIRMED";
        action.gasUsed = receipt.gasUsed.toString();
        action.blockNumber = receipt.blockNumber.toString();
        action.confirmedAt = new Date().toISOString();
        action.error = receipt.status === "reverted" ? "Transaction reverted" : undefined;
        for (const record of await this.txs.byBundle(bundle.id)) {
          if (record.actionId === action.id && record.txHash === action.txHash) {
            await this.txs.update(record.id, {
              status: action.status, gasUsed: action.gasUsed,
              blockNumber: action.blockNumber, error: action.error,
            });
          }
        }
      } catch {
        // Missing receipts and RPC failures are not proof that a transaction failed.
      }
    }
    await this.bundles.save(bundle);
  }

  async reconcileBundle(bundleId: string): Promise<Bundle> {
    return withFileLock(path.resolve(this.config.dataDir, ".execution.lock"), async () => {
      const bundle = await this.require(bundleId);
      await this.reconcileActions(bundle);
      return this.finalize(bundleId);
    }, 0);
  }

  private async finalize(bundleId: string): Promise<Bundle> {
    const bundle = await this.require(bundleId);
    const confirmed = bundle.actions.filter((a) => a.status === "CONFIRMED").length;
    const failed = bundle.actions.filter((a) =>
      [
        "REVERTED",
        "SUBMISSION_FAILED",
        "SIMULATION_FAILED",
        "TIMEOUT",
        "NONCE_ERROR",
        "INSUFFICIENT_GAS",
      ].includes(a.status),
    ).length;
    const pending = bundle.actions.length - confirmed - failed;

    if (failed === 0 && pending === 0) bundle.status = "COMPLETED";
    else if (confirmed > 0 && (failed > 0 || pending > 0)) bundle.status = "PARTIAL";
    else if (failed > 0 && confirmed === 0) bundle.status = "SUBMISSION_FAILED";
    else bundle.status = "SUBMITTED";

    bundle.updatedAt = new Date().toISOString();
    await this.bundles.save(bundle);
    return bundle;
  }

  private async require(id: string): Promise<Bundle> {
    const bundle = await this.bundles.get(id);
    if (!bundle) throw new Error(`Bundle not found: ${id}`);
    assertBundleChain(bundle, this.config);
    return bundle;
  }
}
