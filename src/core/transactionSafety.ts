import type { Bundle, BundleAction } from "../types.js";
import type { AppConfig } from "../config.js";
import { getChain } from "../chain/networks.js";

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
