import path from "node:path";
import type { Bundle, ManagedWallet, RecordedTransaction } from "../types.js";
import { JsonStore } from "./JsonStore.js";
import { hasSubmissionEvidence } from "../core/transactionSafety.js";

/** Check under the store lock so a stale editor cannot erase a concurrent send. */
function retainSubmissionHistory(previous: Bundle, next: Bundle): void {
  for (const old of previous.actions.filter(hasSubmissionEvidence)) {
    const action = next.actions.find(item => item.id === old.id);
    if (!action || previous.chainId !== next.chainId ||
        (old.txHash !== undefined && old.txHash !== action.txHash) ||
        (old.nonce !== undefined && old.nonce !== action.nonce) ||
        old.walletAddress.toLowerCase() !== action.walletAddress.toLowerCase() ||
        old.target?.toLowerCase() !== action.target?.toLowerCase() ||
        (old.valueWei ?? "0") !== (action.valueWei ?? "0") || old.calldata !== action.calldata ||
        (["CONFIRMED", "REVERTED"].includes(old.status) && old.status !== action.status) ||
        (["CREATED", "VALIDATED", "SIMULATED", "CANCELLED"].includes(action.status) && old.status !== action.status)) {
      throw new Error("Cannot erase or rewrite signed transaction history. Reload and reconcile the existing bundle.");
    }
  }
}

export class WalletRepository {
  private store: JsonStore<ManagedWallet[]>;

  constructor(dataDir: string) {
    this.store = new JsonStore(path.join(dataDir, "wallets.json"), []);
  }

  list(): Promise<ManagedWallet[]> {
    return this.store.read();
  }

  async get(address: string): Promise<ManagedWallet | undefined> {
    const all = await this.list();
    return all.find((w) => w.address.toLowerCase() === address.toLowerCase());
  }

  async upsert(wallet: ManagedWallet): Promise<void> {
    await this.store.update((all) => {
      const idx = all.findIndex((w) => w.address.toLowerCase() === wallet.address.toLowerCase());
      if (idx >= 0) {
        const next = [...all];
        next[idx] = wallet;
        return next;
      }
      return [...all, wallet];
    });
  }

  updateAll(mutator: (wallets: ManagedWallet[]) => ManagedWallet[]): Promise<ManagedWallet[]> {
    return this.store.update(mutator);
  }

  async remove(address: string): Promise<boolean> {
    let removed = false;
    await this.store.update((all) => {
      const next = all.filter((w) => {
        const keep = w.address.toLowerCase() !== address.toLowerCase();
        if (!keep) removed = true;
        return keep;
      });
      return next;
    });
    return removed;
  }
}

export class BundleRepository {
  private store: JsonStore<Bundle[]>;

  constructor(dataDir: string) {
    this.store = new JsonStore(path.join(dataDir, "bundles.json"), []);
  }

  list(): Promise<Bundle[]> {
    return this.store.read();
  }

  async get(id: string): Promise<Bundle | undefined> {
    const all = await this.list();
    return all.find((b) => b.id === id);
  }

  async save(bundle: Bundle): Promise<void> {
    await this.store.update((all) => {
      const idx = all.findIndex((b) => b.id === bundle.id);
      if (idx >= 0) {
        retainSubmissionHistory(all[idx], bundle);
        const next = [...all];
        next[idx] = bundle;
        return next;
      }
      return [...all, bundle];
    });
  }

  async delete(id: string): Promise<boolean> {
    let removed = false;
    await this.store.update((all) => {
      const next = all.filter((b) => {
        const keep = b.id !== id;
        if (!keep && b.actions.some(hasSubmissionEvidence)) throw new Error("Cannot delete a bundle with signed transaction history.");
        if (!keep) removed = true;
        return keep;
      });
      return next;
    });
    return removed;
  }
}

export class TransactionRepository {
  private store: JsonStore<RecordedTransaction[]>;

  constructor(dataDir: string) {
    this.store = new JsonStore(path.join(dataDir, "transactions.json"), []);
  }

  list(): Promise<RecordedTransaction[]> {
    return this.store.read();
  }

  async byBundle(bundleId: string): Promise<RecordedTransaction[]> {
    const all = await this.list();
    return all.filter((t) => t.bundleId === bundleId);
  }

  async append(tx: RecordedTransaction): Promise<void> {
    await this.store.update((all) => [...all, tx]);
  }

  async update(id: string, patch: Partial<RecordedTransaction>): Promise<void> {
    await this.store.update((all) =>
      all.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }
}
