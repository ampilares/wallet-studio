export function requireWalletPassphrase(passphrase: string): void {
  if (passphrase.trim().length < 16 || passphrase === "change-me-to-a-strong-passphrase") {
    throw new Error("Set WALLET_PASSPHRASE to a unique passphrase of at least 16 characters; the example value is forbidden.");
  }
}
