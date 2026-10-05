import type { Address, Hash } from "viem";

export interface FundingInput { from: string; wallets: string[]; amount: string; maxFeePerTransfer: string }
export interface FundingLine {
  to: Address; amountWei: string; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
  feeAllowanceWei: string; estimatedFeeWei: string;
  status: "ready" | "signed" | "submitted" | "confirmed" | "reverted" | "unresolved";
  hash?: Hash; actualFeeWei?: string;
}
export interface FundingBatch {
  id: string; chainId: 8453; from: Address; createdAt: string; updatedAt: string; expiresAt: number;
  status: "reviewed" | "running" | "partial" | "stopped" | "completed";
  stopRequested: boolean; lines: FundingLine[]; totalWei: string; feeAllowanceWei: string; requiredWei: string;
  error?: string;
}
