import { randomUUID } from "node:crypto";
import path from "node:path";
import { createPublicClient, createWalletClient, http, formatEther, parseEther, getAddress, isAddress, keccak256, type Address, type Hex, type TransactionRequest } from "viem";
import { anvil, base, baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { JsonStore } from "../database/JsonStore.js";
import { encryptSecret, decryptSecret } from "../wallet/crypto.js";
import { requireWalletPassphrase } from "../wallet/passphrase.js";
import { withFileLock } from "../utils/fileLock.js";
import type { ManagedWallet } from "../types.js";
import type { Activity, NetworkInfo, StudioNetwork, StudioState, TransferInput, TransferPreview } from "./types.js";

export class StudioError extends Error {}
export const NETWORKS: NetworkInfo[] = [
  { key: "local", name: "Local EVM", chainId: 31337, canSend: true, test: true },
  { key: "sepolia", name: "Base Sepolia", chainId: 84532, explorer: "https://sepolia.basescan.org", canSend: true, test: true },
  { key: "mainnet", name: "Base mainnet", chainId: 8453, explorer: "https://basescan.org", canSend: false, test: false },
];
type Encrypted = ReturnType<typeof encryptSecret>;
type Vault = { version: 1; verifier: Encrypted; wallets: ManagedWallet[] };
type Prepared = { address: Address; request: TransactionRequest; amount: bigint; maxCost: bigint };
type Plan = { preview: TransferPreview; transactions: Prepared[] };
const VERIFY = "wallet-studio-v1";
const UNLOCK_MS = 15 * 60_000;

export class StudioService {
  private readonly store: JsonStore<Vault | null>;
  private readonly history: JsonStore<Activity[]>;
  private passphrase = "";
  private unlockedUntil = 0;
  private lockTimer?: ReturnType<typeof setTimeout>;
  private plans = new Map<string, Plan>();
  private busy = false;

  constructor(readonly dataDir: string, readonly localRpc = "http://127.0.0.1:18545") {
    const url = new URL(localRpc);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("Local RPC must use IPv4 loopback HTTP");
    this.store = new JsonStore(path.join(dataDir, "vault.json"), null);
    this.history = new JsonStore(path.join(dataDir, "activity.json"), []);
  }

  network(key: StudioNetwork): NetworkInfo {
    const value = NETWORKS.find(n => n.key === key);
    if (!value) throw new StudioError("Choose a supported network.");
    return value;
  }

  private connection(key: StudioNetwork) {
    this.network(key);
    const chain = key === "local" ? anvil : key === "sepolia" ? baseSepolia : base;
    // The browser never supplies an RPC URL or arbitrary RPC method.
    const transport = http(key === "local" ? this.localRpc : chain.rpcUrls.default.http[0], { timeout: 8_000, retryCount: 0 });
    return { chain, client: createPublicClient({ chain, transport }), transport };
  }

  private async checkedConnection(key: StudioNetwork) {
    const connection = this.connection(key);
    try {
      if (await connection.client.getChainId() !== connection.chain.id) throw new Error("chain mismatch");
    } catch { throw new StudioError("Cannot connect to the selected network. Check the local node or try refreshing."); }
    return connection;
  }

  get unlocked(): boolean {
    if (Date.now() > this.unlockedUntil) this.lock();
    return !!this.passphrase;
  }

  lock(): void { clearTimeout(this.lockTimer); this.passphrase = ""; this.unlockedUntil = 0; this.plans.clear(); }

  private touch(): void {
    this.unlockedUntil = Date.now() + UNLOCK_MS;
    clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.lock(), UNLOCK_MS);
    this.lockTimer.unref();
  }

  private secret(): string {
    if (!this.unlocked) throw new StudioError("Unlock your wallet vault first.");
    this.touch();
    return this.passphrase;
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new StudioError("Another wallet operation is running. Wait for it to finish.");
    this.busy = true;
    try { return await withFileLock(path.join(this.dataDir, ".studio-operation.lock"), work, 0); }
    finally { this.busy = false; }
  }

  private newWallet(passphrase: string, label: string): ManagedWallet {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const encrypted = encryptSecret(key, passphrase);
    return { address: account.address, label, createdAt: new Date().toISOString(), encryptedPrivateKey: encrypted.ciphertext, iv: encrypted.iv, salt: encrypted.salt };
  }

  async setup(passphrase: string, count = 10): Promise<void> {
    if (![1, 10].includes(count)) throw new StudioError("Invalid vault size.");
    try { requireWalletPassphrase(passphrase); } catch { throw new StudioError("Use a unique passphrase of at least 16 characters."); }
    await this.exclusive(async () => {
      await this.store.update(current => {
        if (current) throw new StudioError("A vault already exists. Unlock it to continue.");
        return { version: 1, verifier: encryptSecret(VERIFY, passphrase), wallets: Array.from({ length: count }, (_, i) => this.newWallet(passphrase, `Wallet ${String(i + 1).padStart(2, "0")}`)) };
      });
      this.passphrase = passphrase;
      this.touch();
    });
  }

  async unlock(passphrase: string): Promise<void> {
    const vault = await this.store.read();
    if (!vault) throw new StudioError("Create your wallet vault first.");
    try {
      const v = vault.verifier;
      if (decryptSecret(v.ciphertext, v.iv, v.salt, passphrase) !== VERIFY) throw new Error();
    } catch { throw new StudioError("That passphrase did not unlock this vault."); }
    this.passphrase = passphrase;
    this.touch();
  }

  async addWallets(count: number): Promise<void> {
    const secret = this.secret();
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new StudioError("Create between 1 and 10 wallets at a time.");
    await this.exclusive(async () => {
      await this.store.update(vault => {
        if (!vault || vault.wallets.length + count > 100) throw new StudioError("This vault supports up to 100 wallets.");
        const start = vault.wallets.length;
        return { ...vault, wallets: [...vault.wallets, ...Array.from({ length: count }, (_, i) => this.newWallet(secret, `Wallet ${String(start + i + 1).padStart(2, "0")}`))] };
      });
    });
  }

  async rename(address: string, label: string): Promise<void> {
    this.secret();
    if (!label.trim() || label.trim().length > 40 || /[\x00-\x1f\x7f]/.test(label)) throw new StudioError("Use a name between 1 and 40 characters.");
    await this.store.update(vault => {
      if (!vault || !vault.wallets.some(w => w.address === address)) throw new StudioError("Wallet not found.");
      return { ...vault, wallets: vault.wallets.map(w => w.address === address ? { ...w, label: label.trim() } : w) };
    });
  }

  async backup(): Promise<Vault> {
    this.secret();
    const vault = await this.store.read();
    if (!vault) throw new StudioError("Create your vault first.");
    return vault;
  }

  /** Server-side signing adapter; never exposed as an HTTP endpoint. */
  async getAccount(address: Address) {
    const secret = this.secret();
    const wallet = (await this.store.read())?.wallets.find(w => w.address === address);
    if (!wallet) throw new StudioError("Wallet not found.");
    const account = privateKeyToAccount(decryptSecret(wallet.encryptedPrivateKey, wallet.iv, wallet.salt, secret) as Hex);
    if (account.address !== address) throw new StudioError("Wallet identity check failed.");
    return account;
  }

  async metadata() {
    const vault = await this.store.read();
    return { vaultExists: !!vault, unlocked: this.unlocked, wallets: (vault?.wallets ?? []).map(w => ({ address: w.address, label: w.label })) };
  }

  async state(key: StudioNetwork): Promise<StudioState> {
    const vault = await this.store.read();
    const history = await this.history.read();
    const result: StudioState = { vaultExists: !!vault, unlocked: this.unlocked, wallets: (vault?.wallets ?? []).map(w => ({ address: w.address, label: w.label, createdAt: w.createdAt, balance: null })), networks: NETWORKS, network: this.network(key), blockNumber: null, rpcError: null, activity: history.filter(row => row.network === key).slice(-80).reverse() };
    try {
      const { client } = await this.checkedConnection(key);
      result.blockNumber = String(await client.getBlockNumber());
      for (let i = 0; i < result.wallets.length; i += 4) {
        await Promise.all(result.wallets.slice(i, i + 4).map(async wallet => {
          wallet.balance = formatEther(await client.getBalance({ address: wallet.address as Address }));
        }));
      }
      // Reconcile known hashes without resending an ambiguous transaction.
      const pending = result.activity.filter(row => row.hash && ["signed", "submitted", "unknown"].includes(row.status));
      for (const row of pending) {
        try {
          const receipt = await client.getTransactionReceipt({ hash: row.hash as Hex });
          row.status = receipt.status === "success" ? "confirmed" : "reverted";
          await this.history.update(rows => rows.map(old => old.id === row.id ? { ...old, status: row.status } : old));
        } catch { /* A missing receipt is not evidence that a send failed. */ }
      }
    } catch { result.rpcError = "Network unavailable. Wallets are safe; refresh to reconnect."; }
    return result;
  }

  async fundLocal(addresses: string[]): Promise<void> {
    this.secret();
    await this.exclusive(async () => {
      const vault = await this.store.read();
      const unique = [...new Set(addresses)];
      if (!unique.length || unique.some(a => !vault?.wallets.some(w => w.address === a))) throw new StudioError("Select wallets from this vault.");
      const { client } = await this.checkedConnection("local");
      const version = await client.request({ method: "web3_clientVersion" });
      if (!version.toLowerCase().includes("anvil")) throw new StudioError("Test funding requires the local Anvil node.");
      for (const address of unique) {
        const balance = await client.getBalance({ address: address as Address });
        await client.request({ method: "anvil_setBalance" as never, params: [address, `0x${(balance + parseEther("10")).toString(16)}`] as never });
        await this.history.update(rows => [...rows, { id: randomUUID(), network: "local", kind: "test-funds", to: address, amount: "10", status: "confirmed", createdAt: new Date().toISOString() }]);
      }
    });
  }

  async preview(input: TransferInput): Promise<TransferPreview> {
    this.secret();
    const info = this.network(input.network);
    if (!info.canSend) throw new StudioError("Base mainnet is read-only in Wallet Studio. Use Local EVM or Base Sepolia for testing.");
    const vault = await this.store.read();
    if (!vault) throw new StudioError("Create your wallet vault first.");
    const { client, chain, transport } = await this.checkedConnection(input.network);
    const managed = (address: string): Address => {
      const wallet = vault.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
      if (!wallet) throw new StudioError("The sending wallet must belong to this vault.");
      return wallet.address;
    };
    const recipient = (address: string): Address => {
      if (!isAddress(address) || /^0x0{40}$/i.test(address)) throw new StudioError("Enter a valid, non-zero recipient address.");
      return getAddress(address);
    };
    let amount: bigint;
    try {
      if (!/^\d+(\.\d{1,18})?$/.test(input.amount)) throw new Error();
      amount = parseEther(input.amount);
      if (amount <= 0n) throw new Error();
    } catch { throw new StudioError("Enter an ETH amount greater than zero, with up to 18 decimal places."); }
    const selected = [...new Set(input.wallets)];
    if (selected.length > 100) throw new StudioError("Too many wallets selected.");
    const pairs = input.kind === "send" ? [{ from: managed(input.from), to: recipient(input.to) }]
      : input.kind === "distribute" ? selected.map(a => ({ from: managed(input.from), to: managed(a) }))
      : selected.map(a => ({ from: managed(a), to: recipient(input.to) }));
    if (!pairs.length) throw new StudioError("Select at least one wallet.");
    if (pairs.some(p => p.from.toLowerCase() === p.to.toLowerCase())) throw new StudioError("The sender and recipient must be different wallets.");
    const history = await this.history.read();
    if (history.some(row => row.network === input.network && row.kind === "transfer" && ["signed", "submitted", "unknown"].includes(row.status) && pairs.some(pair => pair.from === row.from))) {
      throw new StudioError("A selected wallet has an unresolved transaction. Refresh activity for its receipt before sending again.");
    }
    const transactions: Prepared[] = [];
    const nonces = new Map<Address, number>();
    const costs = new Map<Address, bigint>();
    const walletClient = createWalletClient({ chain, transport });
    for (const pair of pairs) {
      const nonce = nonces.get(pair.from) ?? await client.getTransactionCount({ address: pair.from, blockTag: "pending" });
      nonces.set(pair.from, nonce + 1);
      const request = await walletClient.prepareTransactionRequest({ account: pair.from, to: pair.to, value: amount, chain, nonce });
      const maxCost = request.gas * (request.maxFeePerGas ?? request.gasPrice ?? 0n);
      // Additional headroom for Sepolia L1 data fees; this is a reserve, not a quote.
      const reserve = input.network === "sepolia" ? parseEther("0.0001") : 0n;
      costs.set(pair.from, (costs.get(pair.from) ?? 0n) + amount + maxCost + reserve);
      transactions.push({ address: pair.from, request, amount, maxCost });
    }
    for (const [address, cost] of costs) {
      if (await client.getBalance({ address }) < cost) throw new StudioError("Insufficient ETH for this transfer and its fees. Add test ETH or reduce the amount.");
    }
    const preview: TransferPreview = { id: randomUUID(), network: info, expiresAt: Date.now() + 60_000,
      lines: transactions.map(tx => ({ from: tx.address, to: tx.request.to!, amount: formatEther(tx.amount), maxFee: formatEther(tx.maxCost) })),
      total: formatEther(amount * BigInt(pairs.length)), maxFees: formatEther(transactions.reduce((sum, tx) => sum + tx.maxCost, 0n)) };
    this.plans.clear();
    this.plans.set(preview.id, { preview, transactions });
    return preview;
  }

  async execute(id: string): Promise<{ sent: number }> {
    const secret = this.secret();
    return this.exclusive(async () => {
      const plan = this.plans.get(id);
      this.plans.delete(id); // Single-use, including errors or ambiguous broadcasts.
      if (!plan || Date.now() > plan.preview.expiresAt) throw new StudioError("This review expired or was already used. Review a new transfer.");
      const { client, chain } = await this.checkedConnection(plan.preview.network.key);
      const vault = await this.store.read();
      let sent = 0;
      for (const tx of plan.transactions) {
        const wallet = vault?.wallets.find(w => w.address === tx.address);
        if (!wallet) throw new StudioError("Wallet not found.");
        const account = privateKeyToAccount(decryptSecret(wallet.encryptedPrivateKey, wallet.iv, wallet.salt, secret) as Hex);
        if (account.address !== tx.address) throw new StudioError("Wallet identity check failed.");
        if (await client.getTransactionCount({ address: tx.address, blockTag: "pending" }) !== tx.request.nonce) throw new StudioError("Wallet nonce changed. Refresh and review again.");
        const signed = await account.signTransaction({ ...tx.request, chainId: chain.id } as Parameters<typeof account.signTransaction>[0]);
        const hash = keccak256(signed);
        const record: Activity = { id: randomUUID(), network: plan.preview.network.key, kind: "transfer", from: tx.address, to: tx.request.to!, amount: formatEther(tx.amount), hash, status: "signed", createdAt: new Date().toISOString() };
        await this.history.update(rows => [...rows, record]);
        try {
          const returnedHash = await client.sendRawTransaction({ serializedTransaction: signed });
          if (returnedHash !== hash) throw new Error("hash mismatch");
          await this.history.update(rows => rows.map(row => row.id === record.id ? { ...row, status: "submitted" } : row));
          const receipt = await client.waitForTransactionReceipt({ hash, timeout: 20_000 });
          await this.history.update(rows => rows.map(row => row.id === record.id ? { ...row, status: receipt.status === "success" ? "confirmed" : "reverted" } : row));
          if (receipt.status !== "success") throw new StudioError("The transaction reverted. See activity before sending again.");
          sent++;
        } catch {
          throw new StudioError(`Submission stopped after ${sent} confirmed transfer(s). Check activity and refresh for receipts before creating another transfer.`);
        }
      }
      return { sent };
    });
  }
}
