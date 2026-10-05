import {
  formatEther,
  parseEther,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config.js";
import type { RpcManager } from "../chain/RpcManager.js";
import type { WalletRepository } from "../database/repositories.js";
import type { ManagedWallet, WalletStatus } from "../types.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { requireWalletPassphrase } from "./passphrase.js";
import type { NonceManager } from "./NonceManager.js";
import { reconcileDirectTransactions, sendDirectTransaction } from "../core/DirectTransactionSender.js";

export class WalletManager {
  constructor(
    private readonly config: AppConfig,
    private readonly repo: WalletRepository,
    private readonly rpc: RpcManager,
    private readonly nonces: NonceManager,
  ) {}

  async createWallet(label?: string): Promise<ManagedWallet> {
    const privateKey = generatePrivateKey();
    return this.persistKey(privateKey, label ?? `wallet-${Date.now()}`);
  }

  async importWallet(privateKey: Hex, label?: string): Promise<ManagedWallet> {
    const normalized = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
    try {
      privateKeyToAccount(normalized);
    } catch {
      throw new Error("Invalid private key");
    }
    return this.persistKey(normalized, label ?? `imported-${Date.now()}`);
  }

  private async persistKey(privateKey: Hex, label: string): Promise<ManagedWallet> {
    const account = privateKeyToAccount(privateKey);
    const encrypted = encryptSecret(privateKey, this.config.walletPassphrase);
    const wallet: ManagedWallet = {
      address: account.address,
      label,
      createdAt: new Date().toISOString(),
      encryptedPrivateKey: encrypted.ciphertext,
      iv: encrypted.iv,
      salt: encrypted.salt,
    };
    await this.repo.upsert(wallet);
    return wallet;
  }

  async listWallets(): Promise<ManagedWallet[]> {
    return this.repo.list();
  }

  /** Explicit, atomic migration; changing the environment alone cannot re-encrypt keys. */
  async rotatePassphrase(currentPassphrase: string, newPassphrase: string): Promise<number> {
    requireWalletPassphrase(newPassphrase);
    const wallets = await this.repo.updateAll((rows) => rows.map((wallet) => {
      const pk = decryptSecret(wallet.encryptedPrivateKey, wallet.iv, wallet.salt, currentPassphrase) as Hex;
      if (privateKeyToAccount(pk).address.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error("Wallet address does not match its encrypted key");
      }
      const encrypted = encryptSecret(pk, newPassphrase);
      return { ...wallet, encryptedPrivateKey: encrypted.ciphertext, iv: encrypted.iv, salt: encrypted.salt };
    }));
    this.config.walletPassphrase = newPassphrase;
    return wallets.length;
  }

  async getAccount(address: Address): Promise<PrivateKeyAccount> {
    requireWalletPassphrase(this.config.walletPassphrase);
    const wallet = await this.repo.get(address);
    if (!wallet) throw new Error(`Wallet not found: ${address}`);
    const pk = decryptSecret(
      wallet.encryptedPrivateKey,
      wallet.iv,
      wallet.salt,
      this.config.walletPassphrase,
    ) as Hex;
    const account = privateKeyToAccount(pk);
    if (account.address.toLowerCase() !== address.toLowerCase()) throw new Error("Wallet identity check failed");
    return account;
  }

  async getBalance(address: Address): Promise<bigint> {
    return this.rpc.getPublicClient().getBalance({ address });
  }

  async getTokenBalance(address: Address, token: Address): Promise<bigint> {
    const client = this.rpc.getPublicClient();
    return client.readContract({
      address: token,
      abi: [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ] as const,
      functionName: "balanceOf",
      args: [address],
    });
  }

  async getWalletStatus(address: Address): Promise<WalletStatus> {
    const wallet = await this.repo.get(address);
    if (!wallet) throw new Error(`Wallet not found: ${address}`);
    const ethBalanceWei = await this.getBalance(address);
    const nonce = await this.nonces.reconcileNonces(address);
    const minGas = parseEther(String(this.config.minGasEth));
    return {
      address,
      label: wallet.label,
      ethBalanceWei: ethBalanceWei.toString(),
      ethBalanceEth: formatEther(ethBalanceWei),
      hasMinGas: ethBalanceWei >= minGas,
      confirmedNonce: nonce.confirmed,
      pendingNonce: nonce.pending,
    };
  }

  async fundWallet(
    from: Address,
    to: Address,
    amountEth: string,
  ): Promise<{ hash?: Hex; simulated: boolean }> {
    const value = parseEther(amountEth);
    if (value <= 0n) throw new Error("Funding amount must be positive");
    return sendDirectTransaction(this.config, this.rpc, this.nonces, from, () => this.getAccount(from), { to, value });
  }

  async consolidateWallet(
    from: Address,
    to: Address,
    leaveGasEth?: string,
  ): Promise<{ hash?: Hex; amountWei: string; simulated: boolean }> {
    const leave = parseEther(leaveGasEth ?? String(this.config.minGasEth));
    if (leave < 0n) throw new Error("Gas reserve cannot be negative");
    const balance = await this.getBalance(from);
    if (balance <= leave) {
      throw new Error(`Insufficient balance to consolidate from ${from}`);
    }
    const amount = balance - leave;
    const result = await sendDirectTransaction(this.config, this.rpc, this.nonces, from, () => this.getAccount(from), { to, value: amount });
    return { ...result, amountWei: amount.toString() };
  }

  reconcileTransactions() { return reconcileDirectTransactions(this.config, this.rpc); }

  async removeWallet(address: Address): Promise<boolean> {
    return this.repo.remove(address);
  }
}
