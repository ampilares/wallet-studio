import type { Bundle, BundleAction } from "../types.js";
import type { AppConfig } from "../config.js";
import { getChain } from "../chain/networks.js";
import { createHash } from "node:crypto";
import type { Address } from "viem";
import type { BundleRepository } from "../database/repositories.js";

export async function assertNoUnresolvedBundles(repo: BundleRepository, chainId: number, wallets: readonly Address[], exceptId?: string): Promise<void> {
  const selected = new Set(wallets.map(address => address.toLowerCase()));
  const conflict = (await repo.list()).find(bundle => bundle.id !== exceptId &&
    (bundle.chainId === undefined || bundle.chainId === chainId) && bundle.actions.some(action =>
      selected.has(action.walletAddress.toLowerCase()) && hasSubmissionEvidence(action) &&
      !["CONFIRMED", "REVERTED"].includes(action.status)));
  if (conflict) throw new Error(`Wallet has an unresolved transaction in bundle ${conflict.id}. Reconcile that bundle before sending again.`);
}

export function assertBundleChain(bundle: Bundle, config: AppConfig): void {
  const expected = getChain(config.network).id;
  if (bundle.chainId == null) {
    throw new Error("Legacy bundle has no chainId. Create a new bundle for the selected Base network.");
  }
  if (bundle.chainId !== expected) {
    throw new Error(`Bundle chain mismatch: expected ${expected}, received ${bundle.chainId}`);
  }
}

export const MOCK_ROUTER = "0x0000000000000000000000000000000000000001";

export function isMockAction(action: BundleAction): boolean {
  return action.params?.dex === "mock" || action.target?.toLowerCase() === MOCK_ROUTER;
}

/** Persisted submission evidence must never be erased by automatic recovery. */
export function hasSubmissionEvidence(action: BundleAction): boolean {
  return action.txHash !== undefined || action.nonce !== undefined ||
    ["SIGNED", "SUBMITTED", "TIMEOUT", "NONCE_ERROR", "REVERTED"].includes(action.status);
}

export function bundleFingerprint(bundle: Bundle): string {
  const payload = {
    chainId: bundle.chainId,
    mode: bundle.mode,
    gasPlan: bundle.gasPlan,
    actions: bundle.actions.map((a) => ({
      type: a.type, walletAddress: a.walletAddress.toLowerCase(),
      target: a.target?.toLowerCase(), valueWei: a.valueWei ?? "0", calldata: a.calldata, params: a.params,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function assertFreshDryRun(bundle: Bundle, maxAgeMs = 10 * 60_000): void {
  if (!bundle.dryRun || bundle.dryRun.chainId !== bundle.chainId ||
      bundle.dryRun.fingerprint !== bundleFingerprint(bundle)) {
    throw new Error("Mainnet execution requires a successful dry run of this exact bundle");
  }
  const age = Date.now() - Date.parse(bundle.dryRun.verifiedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    throw new Error("Mainnet dry run is stale; simulate this exact bundle again");
  }
}

export function assertGarlicSpendCeilings(bundle: Bundle): void {
  const totals = new Map<string, bigint>();
  const ceilings = new Map<string, bigint>();
  for (const action of bundle.actions) {
    const preset = action.params?.garlicPreset;
    if (preset !== "buyNative" && preset !== "buyAdapter") continue;
    const ceiling = BigInt(String(action.params?.walletSpendCeilingWei ?? "0"));
    const spend = BigInt(action.valueWei ?? String(action.params?.amountIn ?? "0"));
    if (ceiling <= 0n || spend <= 0n) throw new Error(`Garlic action ${action.id} has no bounded spend ceiling`);
    const key = action.walletAddress.toLowerCase();
    const priorCeiling = ceilings.get(key);
    if (priorCeiling !== undefined && priorCeiling !== ceiling) {
      throw new Error(`Garlic wallet spend ceiling is inconsistent for ${action.walletAddress}`);
    }
    ceilings.set(key, ceiling);
    const total = (totals.get(key) ?? 0n) + spend;
    if (total > ceiling) throw new Error(`Garlic wallet spend ceiling exceeded for ${action.walletAddress}`);
    totals.set(key, total);
    const quoted = BigInt(String(action.params?.quotedTokens ?? "0"));
    const remaining = BigInt(String(action.params?.factoryRemainingTokens ?? "0"));
    if (quoted <= 0n || (action.params?.factoryCapApplies !== false && quoted > remaining)) {
      throw new Error(`Garlic factory allocation cap exceeded for ${action.walletAddress}`);
    }
  }
}
