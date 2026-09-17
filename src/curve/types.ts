export type CurveOperation = "buy" | "sell" | "graduate";
export type CurveRequest = { payment?: "cbBTC" | "ETH" | "WETH" | "USDC"; operation: CurveOperation; amount: string; wallets: string[]; tight: boolean };
export type CurvePreview = { payment?: string; id: string; expiresAt: number; operation: CurveOperation; venue: string; amount: string; total: string; maximumGasEth: string; rows: { address: string; expected: string; minimum: string }[] };
export type CurveView = {
  paymentsEnabled?: boolean;
  network?: "local" | "sepolia";
  runId: string; busy: boolean; phase: string; error: string | null; website: string; browserWallet: string;
  open: boolean; graduated: boolean; canGraduate: boolean; quoteReserve: string; tokenReserve: string; target: string;
  guard: { cap: string; blocks: number; endBlock: string; remainingBlocks: string; active: boolean };
  wallets: { address: string; label: string; eth: string; quote: string; token: string; allowance: string; guardPurchased: string; guardRemaining: string }[];
  bundles: { id: string; name: string; status: string; actions: { walletAddress: string; status: string; txHash?: string; blockNumber?: string }[] }[];
  report?: { name: string; passed: boolean; detail: string }[];
};
