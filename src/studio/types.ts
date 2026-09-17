export type StudioNetwork = "local" | "sepolia" | "mainnet";
export type NetworkInfo = { key: StudioNetwork; name: string; chainId: number; explorer?: string; canSend: boolean; test: boolean };
export type WalletView = { address: string; label: string; createdAt: string; balance: string | null };
export type Activity = { id: string; network: StudioNetwork; kind: "transfer" | "test-funds"; from?: string; to: string; amount: string; hash?: string; status: "signed" | "submitted" | "confirmed" | "reverted" | "unknown"; createdAt: string };
export type StudioState = {
  vaultExists: boolean; unlocked: boolean; wallets: WalletView[]; network: NetworkInfo;
  networks: NetworkInfo[]; blockNumber: string | null; rpcError: string | null; activity: Activity[];
};
export type TransferInput = { network: StudioNetwork; kind: "send" | "distribute" | "collect"; from: string; to: string; wallets: string[]; amount: string };
export type TransferLine = { from: string; to: string; amount: string; maxFee: string };
export type TransferPreview = { id: string; network: NetworkInfo; expiresAt: number; lines: TransferLine[]; total: string; maxFees: string };
