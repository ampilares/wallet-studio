import path from "node:path";
import { randomUUID } from "node:crypto";
import { keccak256, type Address, type Hash, type Hex, type PrivateKeyAccount } from "viem";
import type { AppConfig } from "../config.js";
import type { RpcManager } from "../chain/RpcManager.js";
import type { NonceManager } from "../wallet/NonceManager.js";
import { JsonStore } from "../database/JsonStore.js";
import { BundleRepository } from "../database/repositories.js";
import { withFileLock } from "../utils/fileLock.js";
import { assertNoUnresolvedBundles } from "./transactionSafety.js";

export type DirectTransaction = {
  id: string; chainId: number; from: Address; to: Address; valueWei: string;
  nonce: number; hash: Hash; status: "signed" | "submitted" | "confirmed" | "reverted";
  createdAt: string;
};

const journal = (config: AppConfig) => new JsonStore<DirectTransaction[]>(path.join(config.dataDir, "direct-transactions.json"), []);
const pending = (row: DirectTransaction) => row.status === "signed" || row.status === "submitted";

/** Caller holds .execution.lock. Only receipts resolve a previous spending instruction. */
export async function assertNoPendingDirectTransactions(config: AppConfig, chainId: number, wallets: readonly Address[]) {
  const selected = new Set(wallets.map(address => address.toLowerCase()));
  if ((await journal(config).read()).some(row => row.chainId === chainId && selected.has(row.from.toLowerCase()) && pending(row))) {
    throw new Error("Wallet has an unresolved direct transaction. Run wallet reconcile and inspect its hash before sending again.");
  }
}

export async function reconcileDirectTransactions(config: AppConfig, rpc: RpcManager): Promise<DirectTransaction[]> {
  return withFileLock(path.resolve(config.dataDir, ".execution.lock"), async () => {
    const client = rpc.getPublicClient();
    if (await client.getChainId() !== rpc.chain.id) throw new Error("RPC chain mismatch during direct transaction reconciliation");
    const store = journal(config);
    for (const row of (await store.read()).filter(row => row.chainId === rpc.chain.id && pending(row))) {
      try {
        const receipt = await client.getTransactionReceipt({ hash: row.hash });
        if (receipt.transactionHash !== row.hash) continue;
        const block = await client.getBlock({ blockNumber: receipt.blockNumber });
        if (block.hash !== receipt.blockHash) continue;
        await store.update(rows => rows.map(item => item.id === row.id ? { ...item, status: receipt.status === "success" ? "confirmed" : "reverted" } : item));
      } catch { /* An unavailable receipt never authorizes another signature. */ }
    }
    return (await store.read()).filter(row => row.chainId === rpc.chain.id);
  }, 0);
}

/** Used by every legacy wallet/token send; shares the bundle executor's lock. */
export async function sendDirectTransaction(
  config: AppConfig, rpc: RpcManager, nonces: NonceManager,
  from: Address, getAccount: () => Promise<PrivateKeyAccount>,
  request: { to: Address; value?: bigint; data?: Hex },
): Promise<{ hash?: Hash; simulated: boolean }> {
  if (config.mode === "live" && config.network === "mainnet" && !config.mainnetSendEnabled) {
    throw new Error("Mainnet send is disabled; set MAINNET_SEND_ENABLED=true only for an approved broadcast session");
  }
  return withFileLock(path.resolve(config.dataDir, ".execution.lock"), async () => {
    const client = rpc.getPublicClient();
    if (await client.getChainId() !== rpc.chain.id) throw new Error("RPC chain mismatch before direct transaction signing");
    if (config.mode === "simulation") {
      await client.estimateGas({ ...request, account: from });
      return { simulated: true };
    }
    await assertNoPendingDirectTransactions(config, rpc.chain.id, [from]);
    await assertNoUnresolvedBundles(new BundleRepository(config.dataDir), rpc.chain.id, [from]);
    const account = await getAccount();
    if (account.address.toLowerCase() !== from.toLowerCase()) throw new Error("Wallet identity check failed");
    await nonces.reconcileNonces(from);
    const nonce = await nonces.reserveNonce(from);
    let hash: Hash | undefined;
    let reverted = false;
    try {
      const wallet = rpc.createWalletClient(account);
      const prepared = await wallet.prepareTransactionRequest({ ...request, account, chain: rpc.chain, nonce });
      const signed = await wallet.signTransaction(prepared);
      hash = keccak256(signed);
      const store = journal(config);
      const record: DirectTransaction = { id: randomUUID(), chainId: rpc.chain.id, from, to: request.to, valueWei: String(request.value ?? 0n), nonce, hash, status: "signed", createdAt: new Date().toISOString() };
      await store.update(rows => [...rows, record]);
      const returned = await client.sendRawTransaction({ serializedTransaction: signed });
      if (returned !== hash) throw new Error("RPC hash mismatch");
      await store.update(rows => rows.map(row => row.id === record.id ? { ...row, status: "submitted" } : row));
      await nonces.markNonceSubmitted(from, nonce);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 20_000 });
      if (receipt.transactionHash !== hash) throw new Error("Receipt identity mismatch");
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) throw new Error("Receipt is not canonical");
      await store.update(rows => rows.map(row => row.id === record.id ? { ...row, status: receipt.status === "success" ? "confirmed" : "reverted" } : row));
      reverted = receipt.status !== "success";
      if (reverted) throw new Error("Direct transaction reverted");
      return { hash, simulated: false };
    } catch {
      if (reverted) throw new Error(`Direct transaction reverted (${hash}). Inspect the receipt before creating another spending instruction.`);
      if (!hash) {
        await nonces.releaseNonce(from, nonce);
        throw new Error("Direct transaction preparation failed before broadcast. Check the selected network, call and balance.");
      }
      // Never release a possibly-broadcast nonce or expose provider payloads.
      throw new Error(`Direct transaction outcome is unresolved (${hash}). Run wallet reconcile; do not repeat the spending instruction.`);
    }
  }, 0);
}
