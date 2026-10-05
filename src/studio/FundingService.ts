import { randomUUID } from "node:crypto";
import path from "node:path";
import { getAddress, keccak256, parseEther, parseAbi, parseTransaction, recoverTransactionAddress, type Address, type Hash, type Hex } from "viem";
import { estimateL1Fee } from "viem/op-stack";
import { JsonStore } from "../database/JsonStore.js";
import { mapPool } from "../utils/concurrency.js";
import { StudioError, type StudioService } from "./service.js";
import type { FundingBatch, FundingInput, FundingLine } from "./fundingTypes.js";
import { MAX_STUDIO_WALLETS } from "./limits.js";

type StoredLine = FundingLine & { recovery?: { ciphertext: string; iv: string; salt: string } };
type StoredBatch = Omit<FundingBatch, "lines"> & { lines: StoredLine[] };
type Client = Awaited<ReturnType<StudioService["chainConnection"]>>["client"];
const oracle = "0x420000000000000000000000000000000000000F";
const oracleAbi = parseAbi(["function getOperatorFee(uint256) view returns (uint256)"]);
const timestamp = () => new Date().toISOString();
const publicBatch = (batch: StoredBatch): FundingBatch => ({ ...batch, lines: batch.lines.map(({ recovery: _recovery, ...line }) => line) });
const terminal = (line: FundingLine) => line.status === "confirmed" || line.status === "reverted";

function eth(value: string) {
  if (!/^\d+(\.\d{1,18})?$/.test(value) || parseEther(value) <= 0n) throw new StudioError("Enter positive ETH amounts using at most 18 decimal places.");
  return parseEther(value);
}

/** Base-only ETH distribution. Separate from unrestricted send/collect controls. */
export class FundingService {
  private readonly store: JsonStore<StoredBatch[]>;
  private readonly workers = new Map<string, Promise<void>>();
  constructor(private readonly studio: StudioService) {
    this.store = new JsonStore(path.join(studio.dataDir, "mainnet-funding.json"), []);
  }
  async list(): Promise<FundingBatch[]> { return (await this.store.read()).map(publicBatch).reverse(); }
  private async get(id: string) {
    const batch = (await this.store.read()).find(item => item.id === id);
    if (!batch) throw new StudioError("Funding batch not found.");
    return batch;
  }
  private async update(id: string, mutate: (batch: StoredBatch) => StoredBatch) {
    let result!: StoredBatch;
    await this.store.update(rows => rows.map(row => row.id === id ? (result = { ...mutate(row), updatedAt: timestamp() }) : row));
    if (!result) throw new StudioError("Funding batch not found.");
    return result;
  }
  async assertNoPending(wallet: Address, exceptId?: string) {
    if ((await this.store.read()).some(batch => batch.id !== exceptId && batch.from.toLowerCase() === wallet.toLowerCase() && batch.lines.some(line => line.hash && !terminal(line)))) throw new StudioError("This wallet has an unresolved funding transaction. Reconcile its funding batch first.");
  }
  private async checkOtherOperations(wallet: Address, id?: string) {
    await this.assertNoPending(wallet, id);
    await this.studio.assertNoPendingTransfers("mainnet", [wallet]);
    const campaigns = await this.studio.nft.list("mainnet");
    if (campaigns.some(campaign => campaign.jobs.some(job => job.wallet.toLowerCase() === wallet.toLowerCase() && job.txHash && ["signed", "submitted", "included", "unresolved"].includes(job.status)))) throw new StudioError("The funding wallet has an unresolved NFT transaction. Reconcile that campaign first.");
  }
  private async connection() {
    const connection = await this.studio.chainConnection("mainnet");
    if (connection.chain.id !== 8453 || await connection.client.getChainId() !== 8453) throw new StudioError("Funding requires Base mainnet, chain 8453.");
    return connection;
  }
  private async noCode(client: Client, addresses: Address[]) {
    await mapPool(addresses, 4, async address => {
      const code = await client.getCode({ address });
      if (code && !/^0x0*$/.test(code)) throw new StudioError("Bulk funding supports plain vault wallets only, not contracts or delegated wallets.");
    });
  }
  private request(batch: Pick<StoredBatch, "from">, line: FundingLine) {
    return { account: batch.from, to: line.to, value: BigInt(line.amountWei), gas: BigInt(line.gas), nonce: line.nonce, chainId: 8453, type: "eip1559" as const, maxFeePerGas: BigInt(line.maxFeePerGas), maxPriorityFeePerGas: BigInt(line.maxPriorityFeePerGas) };
  }
  private async totalFee(client: Client, batch: Pick<StoredBatch, "from">, line: FundingLine) {
    const request = this.request(batch, line);
    const [l1, operator] = await Promise.all([
      estimateL1Fee(client, request),
      client.readContract({ address: oracle, abi: oracleAbi, functionName: "getOperatorFee", args: [request.gas] }),
    ]);
    return request.gas * request.maxFeePerGas + 2n * (l1 + operator) + 1_000_000_000_000n;
  }
  private async quote(batch: StoredBatch): Promise<StoredBatch> {
    const { client } = await this.connection();
    await this.checkOtherOperations(batch.from, batch.id);
    const pending = batch.lines.filter(line => !line.hash);
    const required = pending.reduce((sum, line) => sum + BigInt(line.amountWei) + BigInt(line.feeAllowanceWei), 0n);
    if (await client.getBalance({ address: batch.from }) < required) throw new StudioError("The funding wallet needs enough Base ETH for all remaining recipients plus the reviewed fee allowances.");
    await this.noCode(client, [batch.from, ...pending.map(line => line.to)]);
    const [nonce, latest, fees] = await Promise.all([client.getTransactionCount({ address: batch.from, blockTag: "pending" }), client.getTransactionCount({ address: batch.from, blockTag: "latest" }), client.estimateFeesPerGas()]);
    if (nonce !== latest) throw new StudioError("The funding wallet has a pending transaction. Wait for its receipt before reviewing.");
    if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) throw new StudioError("Base did not return an EIP-1559 fee estimate.");
    const quoted = await mapPool(pending, 4, async (line, index) => {
      const next = { ...line, nonce: nonce + index, gas: "21000", maxFeePerGas: fees.maxFeePerGas!.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas!.toString() };
      const fee = await this.totalFee(client, batch, next);
      if (fee > BigInt(line.feeAllowanceWei)) throw new StudioError("Estimated fees exceed your per-transfer fee allowance. No funds sent.");
      return { ...next, estimatedFeeWei: fee.toString() };
    });
    if (await client.getBalance({ address: batch.from }) < required) throw new StudioError("The funding wallet needs enough Base ETH for all remaining recipients plus the reviewed fee allowances.");
    return { ...batch, lines: batch.lines.map(line => line.hash ? line : quoted.find(next => next.to === line.to)!), expiresAt: Date.now() + 5 * 60_000, status: "reviewed", stopRequested: false, error: undefined };
  }
  async preview(input: FundingInput): Promise<FundingBatch> {
    return this.studio.exclusiveOperation(async () => {
      const amount = eth(input.amount), feeCap = eth(input.maxFeePerTransfer);
      const managed = new Map((await this.studio.metadata()).wallets.map(wallet => [wallet.address.toLowerCase(), wallet.address]));
      const from = managed.get(input.from.toLowerCase());
      if (!from) throw new StudioError("Choose a funding wallet from this vault.");
      await this.studio.getAccount(from);
      const wallets = [...new Set(input.wallets.map(wallet => wallet.toLowerCase()))].filter(wallet => wallet !== from.toLowerCase());
      if (!wallets.length || wallets.length >= MAX_STUDIO_WALLETS || wallets.some(wallet => !managed.has(wallet))) throw new StudioError(`Choose 1–${MAX_STUDIO_WALLETS - 1} other wallets from this vault. The sender is excluded.`);
      if ((await this.store.read()).some(batch => batch.lines.some(line => !!line.hash) && batch.status !== "completed")) throw new StudioError("Finish or reconcile the existing partial funding batch before creating another. Do not pay confirmed recipients again.");
      const time = timestamp();
      const total = amount * BigInt(wallets.length), allowance = feeCap * BigInt(wallets.length);
      const batch: StoredBatch = { id: randomUUID(), chainId: 8453, from, createdAt: time, updatedAt: time, expiresAt: 0, status: "reviewed", stopRequested: false, totalWei: total.toString(), feeAllowanceWei: allowance.toString(), requiredWei: (total + allowance).toString(), lines: wallets.map(wallet => ({ to: managed.get(wallet)!, amountWei: amount.toString(), feeAllowanceWei: feeCap.toString(), estimatedFeeWei: "0", nonce: 0, gas: "21000", maxFeePerGas: "0", maxPriorityFeePerGas: "0", status: "ready" })) };
      const quoted = await this.quote(batch);
      await this.store.update(rows => [...rows, quoted]);
      return publicBatch(quoted);
    });
  }
  async review(id: string): Promise<FundingBatch> {
    return this.studio.exclusiveOperation(async () => {
      await this.reconcileLocked(id);
      const batch = await this.get(id);
      if (batch.lines.some(line => line.hash && !terminal(line))) throw new StudioError("Reconcile the existing hash before refreshing the remaining review.");
      await this.studio.getAccount(batch.from);
      const quoted = await this.quote(batch);
      return publicBatch(await this.update(id, () => quoted));
    });
  }
  async reconcile(id: string) { return this.studio.exclusiveOperation(async () => { await this.reconcileLocked(id); return publicBatch(await this.get(id)); }); }
  async stop(id: string) { return publicBatch(await this.update(id, batch => ({ ...batch, stopRequested: true, status: "stopped" }))); }
  async start(id: string, approved: boolean): Promise<FundingBatch> {
    if (!approved || !/^(true|1)$/i.test(process.env.MAINNET_SEND_ENABLED ?? "")) throw new StudioError("Approve this exact funding batch and enable MAINNET_SEND_ENABLED=true before sending real Base ETH.");
    if (this.workers.has(id)) throw new StudioError("This funding worker is already active.");
    let accept!: (batch: FundingBatch) => void, reject!: (error: unknown) => void;
    const ready = new Promise<FundingBatch>((resolve, fail) => { accept = resolve; reject = fail; });
    let started = false;
    const worker = this.studio.exclusiveOperation(async () => {
      const batch = await this.get(id);
      if (batch.status === "completed") throw new StudioError("This batch has already completed; it cannot be sent again.");
      if (batch.lines.some(line => !line.hash) && Date.now() > batch.expiresAt) throw new StudioError("Review expired. Refresh the remaining review before continuing.");
      await this.studio.getAccount(batch.from);
      await this.connection();
      await this.checkOtherOperations(batch.from, id);
      const running = await this.update(id, row => ({ ...row, status: "running", stopRequested: false, error: undefined }));
      started = true; accept(publicBatch(running));
      try { await this.run(id); }
      catch (error) { await this.update(id, row => ({ ...row, status: row.stopRequested ? "stopped" : "partial", error: error instanceof StudioError ? error.message : "Funding stopped. Reconcile the recorded hashes before resuming; no signed recipient will be paid with a new transaction." })); }
    }).catch(error => { if (!started) reject(error); }).finally(() => this.workers.delete(id));
    this.workers.set(id, worker);
    return ready;
  }
  private async settle(id: string, hash: Hash, client: Client) {
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.transactionHash !== hash) throw new Error("Receipt identity mismatch");
    const [block, head] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
    if (block.hash !== receipt.blockHash || head < receipt.blockNumber + 1n) throw new Error("Awaiting two confirmations");
    const l1 = (receipt as typeof receipt & { l1Fee?: bigint | null }).l1Fee;
    if (typeof l1 !== "bigint") throw new Error("Missing Base L1 fee");
    const operator = await client.readContract({ address: oracle, abi: oracleAbi, functionName: "getOperatorFee", args: [receipt.gasUsed], blockNumber: receipt.blockNumber });
    const fee = receipt.gasUsed * receipt.effectiveGasPrice + l1 + operator;
    await this.update(id, batch => ({ ...batch, lines: batch.lines.map(line => line.hash !== hash ? line : { ...line, status: receipt.status === "success" ? "confirmed" : "reverted", actualFeeWei: fee.toString() }) }));
  }
  private async reconcileLocked(id: string) {
    const batch = await this.get(id);
    const { client } = await this.connection();
    for (const line of batch.lines.filter(line => line.hash && !terminal(line))) {
      try { await this.settle(id, line.hash!, client); } catch { /* Missing receipt or fees: retain identity and block new sends. */ }
    }
    await this.update(id, row => ({ ...row, status: row.lines.every(terminal) ? "completed" : row.status }));
  }
  private async run(id: string) {
    await this.reconcileLocked(id);
    const { client } = await this.connection();
    for (let index = 0; index < (await this.get(id)).lines.length; index++) {
      let batch = await this.get(id), line = batch.lines[index];
      if (batch.stopRequested) return;
      if (terminal(line)) continue;
      if (!/^(true|1)$/i.test(process.env.MAINNET_SEND_ENABLED ?? "")) throw new StudioError("Mainnet send gate is now disabled.");
      let signed: Hex;
      if (line.hash) {
        if (!line.recovery) throw new StudioError("Recovery bytes missing. Inspect the recorded hash; do not create a replacement batch.");
        signed = this.studio.openForSession(line.recovery.ciphertext, line.recovery.iv, line.recovery.salt) as Hex;
        if (!signed.startsWith("0x02") || keccak256(signed) !== line.hash) throw new Error("Invalid recovery journal");
        const tx = parseTransaction(signed);
        if (tx.chainId !== 8453 || tx.to?.toLowerCase() !== line.to.toLowerCase() || tx.value !== BigInt(line.amountWei) || tx.nonce !== line.nonce || (tx.data && tx.data !== "0x") || getAddress(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })) !== batch.from) throw new Error("Recovery identity mismatch");
      } else {
        await this.checkOtherOperations(batch.from, id);
        await this.noCode(client, [batch.from, line.to]);
        const [pending, latest, block, balance, estimate] = await Promise.all([client.getTransactionCount({ address: batch.from, blockTag: "pending" }), client.getTransactionCount({ address: batch.from, blockTag: "latest" }), client.getBlock(), client.getBalance({ address: batch.from }), this.totalFee(client, batch, line)]);
        if (pending !== line.nonce || latest !== line.nonce) throw new StudioError("Funding wallet nonce changed. Reconcile and refresh the remaining review.");
        if ((block.baseFeePerGas ?? 0n) + BigInt(line.maxPriorityFeePerGas) > BigInt(line.maxFeePerGas) || estimate > BigInt(line.feeAllowanceWei)) throw new StudioError("Fees changed. Refresh the remaining review; no new transaction was signed.");
        const remaining = batch.lines.filter(item => !item.hash).reduce((sum, item) => sum + BigInt(item.amountWei) + BigInt(item.feeAllowanceWei), 0n);
        if (balance < remaining) throw new StudioError("Funding wallet balance changed. Top it up before continuing the remaining batch.");
        const account = await this.studio.getAccount(batch.from);
        if ((await this.get(id)).stopRequested) return;
        const { account: _account, ...request } = this.request(batch, line);
        signed = await account.signTransaction(request);
        const recovery = this.studio.sealForSession(signed), hash = keccak256(signed);
        batch = await this.update(id, row => ({ ...row, lines: row.lines.map((item, i) => i === index ? { ...item, hash, recovery, status: "signed" } : item) }));
        line = batch.lines[index];
      }
      if ((await this.get(id)).stopRequested) return;
      const hash = line.hash!;
      try {
        if (!this.studio.unlocked) throw new StudioError("Unlock the vault before submitting funding transactions.");
        if (!/^(true|1)$/i.test(process.env.MAINNET_SEND_ENABLED ?? "")) throw new StudioError("Mainnet send gate is now disabled.");
        const returned = await client.sendRawTransaction({ serializedTransaction: signed });
        if (returned !== hash) throw new Error("RPC hash mismatch");
        await this.update(id, row => ({ ...row, lines: row.lines.map(item => item.hash === hash ? { ...item, status: "submitted" } : item) }));
        await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 45_000 });
        await this.settle(id, hash, client);
      } catch {
        await this.update(id, row => ({ ...row, lines: row.lines.map(item => item.hash === hash && !terminal(item) ? { ...item, status: "unresolved" } : item) }));
        throw new StudioError("Transfer outcome is unresolved. Use Reconcile, then resume this same batch; do not create a new batch.");
      }
      const settled = (await this.get(id)).lines[index];
      if (settled.status === "reverted" || BigInt(settled.actualFeeWei!) > BigInt(settled.feeAllowanceWei)) throw new StudioError("Transfer reverted or actual Base fees exceeded the allowance. Inspect this batch before continuing.");
    }
    await this.update(id, batch => ({ ...batch, status: "completed" }));
  }
}
