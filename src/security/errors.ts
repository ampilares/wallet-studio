import { BaseError } from "viem";

/** Provider errors can embed authenticated URLs, calldata and signed bytes. */
export function safeRpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^RPC chain mismatch: expected \d+, received \d+$/.test(message)) return message;
  if (/rate.limit|too many requests|429/i.test(message)) return "RPC provider rate limit reached. Wait before retrying reads.";
  if (/insufficient funds/i.test(message)) return "Insufficient funds for value and transaction fees.";
  if (/nonce/i.test(message)) return "Transaction nonce conflict. Reconcile recorded transactions before sending again.";
  if (/revert/i.test(message)) return "Contract execution reverted. Review the call and recorded transaction.";
  if (/timeout|timed out/i.test(message)) return "RPC request timed out. Reconcile any recorded hash before sending again.";
  return "RPC operation failed. Check network configuration and reconcile any recorded transaction hash.";
}

export function safeCliError(error: unknown): string {
  if (error instanceof BaseError) return safeRpcError(error);
  let message = error instanceof Error ? error.message : "Operation failed.";
  for (const name of ["WALLET_PASSPHRASE", "ALCHEMY_API_KEY", "RPC_URL", "RPC_URL_SECONDARY", "WS_URL"]) {
    const secret = process.env[name];
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, "[RPC URL redacted]")
    .replace(/0x[a-f0-9]{130,}/gi, "[transaction data redacted]").slice(0, 1000);
}
