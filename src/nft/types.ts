import type { Address, Hash, Hex } from "viem";
import type { StudioNetwork } from "../studio/types.js";

export type NftStandard = "ERC721" | "ERC1155";
export type MintArgument =
  | { kind: "wallet" }
  | { kind: "quantity" }
  | { kind: "literal"; value: unknown }
  | { kind: "wallet-specific"; key: string };

export type MintJobStatus =
  | "draft" | "preflight" | "ready" | "underfunded" | "ineligible"
  | "sale-inactive" | "sold-out" | "contract-error" | "signed"
  | "submitted" | "included" | "confirmed" | "blocked" | "reverted"
  | "cancelled-before-send" | "unresolved";

export type CampaignStatus = "draft" | "reviewed" | "running" | "paused" | "stopped" | "completed" | "partial";

export interface MintCampaignInput {
  adapter?: "btc-genesis-seadrop";
  name: string;
  network: StudioNetwork;
  contract: Address;
  standard: NftStandard;
  functionSignature: string;
  functionName: string;
  arguments: MintArgument[];
  walletArguments?: Record<string, Record<string, unknown>>;
  wallets: Address[];
  quantity: number;
  pricePerTokenWei: string;
  feeBufferWei: string;
  maxFeePerWalletWei: string;
  spendCeilingWei: string;
  confirmations: number;
  concurrency: number;
  mainnetApproved?: boolean;
}

export interface MintPreflightResult {
  wallet: Address;
  status: MintJobStatus;
  balanceWei: string;
  valueWei: string;
  estimatedGas: string;
  estimatedFeeWei: string;
  requiredWei: string;
  shortfallWei: string;
  reason?: string;
}

export interface TransactionAttempt {
  id: string;
  createdAt: string;
  nonce: number;
  hash: Hash;
  encryptedSignedTransaction: string;
  iv: string;
  salt: string;
  submittedAt?: string;
  receiptBlockHash?: Hash;
  replacementOf?: Hash;
  error?: string;
}

export interface MintJob extends MintPreflightResult {
  reservedWei?: string;
  id: string;
  campaignId: string;
  revision: number;
  calldata: Hex;
  tokenIds: string[];
  tokenQuantities?: Record<string, string>;
  actualFeeWei?: string;
  blockNumber?: string;
  txHash?: Hash;
  error?: string;
  attempts: TransactionAttempt[];
  updatedAt: string;
}

export interface MintCampaign {
  id: string;
  previousCampaignId?: string;
  revision: number;
  status: CampaignStatus;
  control: "run" | "pause" | "stop";
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  fingerprint?: string;
  input: MintCampaignInput;
  jobs: MintJob[];
  reservedWei: string;
  spentWei: string;
}

export interface NftAuditEvent {
  id: string;
  campaignId: string;
  revision: number;
  at: string;
  type: string;
  wallet?: Address;
  detail?: Record<string, string | number | boolean>;
}
