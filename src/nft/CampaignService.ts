import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { formatEther, getAddress, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import { estimateL1Fee } from "viem/op-stack";
import { JsonStore } from "../database/JsonStore.js";
import type { StudioService } from "../studio/service.js";
import { StudioError } from "../studio/service.js";
import { mapPool } from "../utils/concurrency.js";
import { classifySimulationError, decodeMintAmounts, encodeMint, validateCampaignInput } from "./adapter.js";
import { GENESIS, collectionAbi, mintTarget, seaDropAbi } from "./genesis.js";
import type { MintCampaign, MintCampaignInput, MintJob, NftAuditEvent, TransactionAttempt } from "./types.js";

type Connection = Awaited<ReturnType<StudioService["chainConnection"]>>;
const oracle = "0x420000000000000000000000000000000000000F";
const oracleAbi = parseAbi(["function getOperatorFee(uint256) view returns (uint256)"]);
const pendingStates = ["signed", "submitted", "included", "unresolved"];
const now = () => new Date().toISOString();
const fingerprint = (input: MintCampaignInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const hasAttempt = (job: MintJob) => !!job.txHash || job.attempts.length > 0;
const erc1155BalanceAbi = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);

/** Never send recovery ciphertext or wallet-specific proofs to the dashboard. */
export function publicCampaign(campaign: MintCampaign) {
  return { ...campaign, input: { ...campaign.input, walletArguments: undefined }, jobs: campaign.jobs.map(job => ({
    ...job, calldata: undefined, attempts: job.attempts.map(({ id, createdAt, nonce, hash, submittedAt, receiptBlockHash }) => ({ id, createdAt, nonce, hash, submittedAt, receiptBlockHash })),
  })) };
}

export class NftCampaignService {
  private readonly campaigns: JsonStore<MintCampaign[]>;
  private readonly audit: JsonStore<NftAuditEvent[]>;
  private readonly runners = new Map<string, Promise<void>>();

  constructor(private readonly studio: StudioService) {
    this.campaigns = new JsonStore(path.join(studio.dataDir, "nft-campaigns.json"), []);
    this.audit = new JsonStore(path.join(studio.dataDir, "nft-audit.json"), []);
  }

  async list(network?: MintCampaignInput["network"]): Promise<MintCampaign[]> {
    // Listing must not mutate a worker owned by another server process.
    return (await this.campaigns.read()).filter(row => !network || row.input.network === network).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<MintCampaign> {
    const row = (await this.campaigns.read()).find(row => row.id === id);
    if (!row) throw new StudioError("Mint campaign not found.");
    return row;
  }

  async create(input: MintCampaignInput): Promise<MintCampaign> {
    const normalized = this.normalize(input);
    await this.assertWallets(normalized.wallets);
    const timestamp = now();
    const campaign: MintCampaign = { id: randomUUID(), revision: 1, status: "draft", control: "pause", createdAt: timestamp, updatedAt: timestamp, input: normalized, jobs: [], reservedWei: "0", spentWei: "0" };
    await this.campaigns.update(rows => [...rows, campaign]);
    return campaign;
  }

  async update(id: string, input: MintCampaignInput): Promise<MintCampaign> {
    return this.studio.exclusiveOperation(async () => {
      const normalized = this.normalize(input);
      await this.assertWallets(normalized.wallets);
      const previous = await this.get(id);
      if (previous.jobs.some(hasAttempt)) throw new StudioError("A campaign with signed transactions is immutable. Reconcile its recorded hashes first.");
      const timestamp = now();
      const result: MintCampaign = { id: randomUUID(), previousCampaignId: previous.id, revision: previous.revision + 1, status: "draft", control: "pause", createdAt: timestamp, updatedAt: timestamp, input: normalized, jobs: [], reservedWei: "0", spentWei: "0" };
      await this.campaigns.update(rows => [...rows, result]);
      return result;
    });
  }

  async genesisStatus(network: MintCampaignInput["network"] = "mainnet") {
    if (network === "sepolia") throw new StudioError("This collection is on Base mainnet, not Sepolia.");
    const { client } = await this.studio.chainConnection(network);
    const [drop, recipients, stats, block] = await Promise.all([
      client.readContract({ address: GENESIS.seaDrop, abi: seaDropAbi, functionName: "getPublicDrop", args: [GENESIS.collection] }),
      client.readContract({ address: GENESIS.seaDrop, abi: seaDropAbi, functionName: "getAllowedFeeRecipients", args: [GENESIS.collection] }),
      client.readContract({ address: GENESIS.collection, abi: collectionAbi, functionName: "getMintStats", args: [GENESIS.collection] }),
      client.getBlock(),
    ]);
    const matches = drop.mintPrice === 0n && drop.startTime === GENESIS.startTime && drop.endTime === GENESIS.endTime && drop.maxTotalMintableByWallet === 1 && drop.feeBps === 1000 && drop.restrictFeeRecipients && recipients.some(address => address.toLowerCase() === GENESIS.feeRecipient.toLowerCase()) && stats[2] === 256n;
    return { ...GENESIS, chainId: network === "local" ? 31337 : 8453, priceWei: drop.mintPrice.toString(), startTime: drop.startTime, endTime: drop.endTime, minted: stats[1].toString(), maxSupply: stats[2].toString(), matches, active: block.timestamp >= BigInt(drop.startTime) && block.timestamp <= BigInt(drop.endTime), blockTime: Number(block.timestamp), mainnetSendEnabled: /^(true|1)$/i.test(process.env.MAINNET_SEND_ENABLED ?? "") };
  }

  private async checkGenesis(input: MintCampaignInput, wallet?: Address) {
    if (input.adapter !== "btc-genesis-seadrop") return;
    const status = await this.genesisStatus(input.network);
    if (!status.matches) throw new StudioError("On-chain Genesis configuration changed. The pinned free-mint preset is blocked; do not bypass this check.");
    if (!status.active) throw new StudioError(`Sale not active. Opens ${new Date(status.startTime * 1000).toISOString()}; closes ${new Date(status.endTime * 1000).toISOString()}. Run preflight after opening.`);
    if (BigInt(status.minted) >= BigInt(status.maxSupply)) throw new StudioError("Collection sold out.");
    if (wallet) {
      const { client } = await this.studio.chainConnection(input.network);
      const stats = await client.readContract({ address: input.contract, abi: collectionAbi, functionName: "getMintStats", args: [wallet] });
      if (stats[0] >= 1n) throw new StudioError("Wallet already minted its one NFT.");
    }
  }

  private async quote(input: MintCampaignInput, wallet: Address, calldata: Hex, connection: Connection) {
    const { client } = connection;
    const value = BigInt(input.pricePerTokenWei) * BigInt(input.quantity);
    const to = mintTarget(input);
    const [balance, estimated, fees, nonce, latest] = await Promise.all([
      client.getBalance({ address: wallet }), client.estimateGas({ account: wallet, to, data: calldata, value }),
      client.estimateFeesPerGas(), client.getTransactionCount({ address: wallet, blockTag: "pending" }), client.getTransactionCount({ address: wallet, blockTag: "latest" }),
    ]);
    if (nonce !== latest) throw new StudioError("Wallet has a pending transaction. Reconcile it before minting.");
    if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) throw new StudioError("An EIP-1559 fee estimate is required.");
    const gas = (estimated * 120n + 99n) / 100n;
    const request = { to, data: calldata, value, gas, nonce, chainId: connection.chain.id, type: "eip1559" as const, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    let additional = 0n;
    if (input.network !== "local") {
      const [l1Fee, operatorFee] = await Promise.all([
        estimateL1Fee(client, { ...request, account: wallet }),
        client.readContract({ address: oracle, abi: oracleAbi, functionName: "getOperatorFee", args: [gas] }),
      ]);
      // L1 fees cannot be capped by EIP-1559. Estimate conservatively and recheck.
      additional = 2n * (l1Fee + operatorFee);
    }
    const estimatedFee = gas * fees.maxFeePerGas + additional + BigInt(input.feeBufferWei);
    return { request, balance, estimatedFee, required: value + estimatedFee };
  }

  async preflight(id: string): Promise<MintCampaign> {
    return this.studio.exclusiveOperation(async () => {
      const campaign = await this.get(id);
      validateCampaignInput(campaign.input);
      await this.assertWallets(campaign.input.wallets);
      if (campaign.jobs.some(job => hasAttempt(job) && pendingStates.includes(job.status))) throw new StudioError("Use Reconcile transactions before reviewing again. Pending transaction identities must not be discarded.");
      await this.checkGenesis(campaign.input);
      const connection = await this.studio.chainConnection(campaign.input.network);
      for (const address of new Set([campaign.input.contract, mintTarget(campaign.input)])) {
        const code = await connection.client.getCode({ address });
        if (!code || /^0x0*$/.test(code)) throw new StudioError("No deployed collection or mint-router bytecode exists on this network.");
      }
      const jobs = await mapPool(campaign.input.wallets, Math.min(3, campaign.input.concurrency), async wallet => {
        const previous = campaign.jobs.find(job => job.wallet.toLowerCase() === wallet.toLowerCase());
        if (previous && hasAttempt(previous)) return previous;
        const value = BigInt(campaign.input.pricePerTokenWei) * BigInt(campaign.input.quantity);
        const calldata = encodeMint(campaign.input, wallet);
        const job: MintJob = { id: `${id}:${campaign.revision}:${wallet.toLowerCase()}`, campaignId: id, revision: campaign.revision, wallet, valueWei: value.toString(), calldata, tokenIds: [], attempts: [], updatedAt: now(), status: "draft", balanceWei: "0", estimatedGas: "0", estimatedFeeWei: "0", requiredWei: value.toString(), shortfallWei: "0", reservedWei: "0" };
        try {
          await this.assertNoOtherAttempt(campaign, wallet);
          await this.checkGenesis(campaign.input, wallet);
          const quote = await this.quote(campaign.input, wallet, calldata, connection);
          Object.assign(job, { status: quote.estimatedFee > BigInt(campaign.input.maxFeePerWalletWei) ? "blocked" : quote.balance < quote.required ? "underfunded" : "ready", balanceWei: quote.balance.toString(), estimatedGas: quote.request.gas.toString(), estimatedFeeWei: quote.estimatedFee.toString(), requiredWei: quote.required.toString(), shortfallWei: quote.balance < quote.required ? (quote.required - quote.balance).toString() : "0" });
          if (job.status === "blocked") job.reason = "Estimated total fee exceeds the per-wallet fee ceiling.";
          if (job.status === "underfunded") job.reason = `Fund this wallet with at least ${formatEther(quote.required - quote.balance)} more ETH on Base.`;
        } catch (error) {
          const classified = classifySimulationError(error);
          job.status = classified.status;
          job.reason = error instanceof StudioError ? error.message : classified.reason;
        }
        return job;
      });
      const maximum = jobs.filter(job => !hasAttempt(job)).reduce((sum, job) => sum + BigInt(job.valueWei) + BigInt(campaign.input.maxFeePerWalletWei), BigInt(campaign.spentWei));
      if (maximum > BigInt(campaign.input.spendCeilingWei)) {
        for (const job of jobs) if (job.status === "ready") { job.status = "blocked"; job.reason = "Sum of per-wallet fee ceilings exceeds the remaining campaign budget."; }
      }
      const reviewed = jobs.every(job => job.status === "ready" || job.status === "confirmed");
      return this.replace(id, row => ({ ...row, status: reviewed ? "reviewed" : "draft", control: "pause", reviewedAt: now(), fingerprint: fingerprint(row.input), jobs, reservedWei: "0", updatedAt: now() }));
    });
  }

  async start(id: string): Promise<MintCampaign> {
    if (this.runners.has(id)) throw new StudioError("This worker is still active. Wait for it to finish before resuming.");
    let started = false;
    let accept!: (value: MintCampaign) => void;
    let reject!: (reason: unknown) => void;
    const ready = new Promise<MintCampaign>((resolve, fail) => { accept = resolve; reject = fail; });
    const runner = this.studio.exclusiveOperation(async () => {
      const campaign = await this.get(id);
      if (!["reviewed", "paused", "partial", "running"].includes(campaign.status) || !campaign.jobs.length) throw new StudioError("Run a successful preflight review before starting.");
      if (campaign.fingerprint !== fingerprint(campaign.input)) throw new StudioError("Configuration changed. Run preflight again.");
      if (campaign.jobs.some(job => job.status === "ready") && (!campaign.reviewedAt || Date.now() - Date.parse(campaign.reviewedAt) > 5 * 60_000)) throw new StudioError("Review expired after five minutes. Reconcile pending transactions, then run preflight again.");
      if (campaign.jobs.some(job => !["ready", "confirmed", ...pendingStates].includes(job.status))) throw new StudioError("Every unsent wallet must pass preflight first.");
      if (campaign.input.network === "mainnet" && (!campaign.input.mainnetApproved || !/^(true|1)$/i.test(process.env.MAINNET_SEND_ENABLED ?? ""))) throw new StudioError("Mainnet requires campaign approval and MAINNET_SEND_ENABLED=true in the server environment.");
      await this.assertWallets(campaign.input.wallets);
      for (const job of campaign.jobs.filter(job => job.status !== "confirmed")) await this.studio.getAccount(job.wallet);
      const result = await this.replace(id, row => ({ ...row, status: "running", control: "run", updatedAt: now() }));
      started = true;
      accept(result);
      try { await this.run(id); }
      catch { await this.replace(id, row => ({ ...row, status: "partial", control: "pause", updatedAt: now() })); }
    }).catch(error => { if (!started) reject(error); }).finally(() => { this.runners.delete(id); });
    this.runners.set(id, runner);
    return ready;
  }

  private assertCanSend(campaign: MintCampaign) {
    if (!this.studio.unlocked) throw new StudioError("Unlock your wallet vault before submitting transactions.");
    if (campaign.input.network === "mainnet" && (!campaign.input.mainnetApproved || !/^(true|1)$/i.test(process.env.MAINNET_SEND_ENABLED ?? ""))) throw new StudioError("Mainnet send gate is now disabled.");
  }

  async control(id: string, action: "pause" | "resume" | "stop"): Promise<MintCampaign> {
    if (action === "resume") return this.start(id);
    return this.replace(id, row => ({ ...row, control: action, status: action === "pause" ? "paused" : "stopped", updatedAt: now() }));
  }

  async retry(id: string) { return this.preflight(id); }

  async reconcile(id: string): Promise<MintCampaign> {
    return this.studio.exclusiveOperation(async () => {
      await this.reconcilePending(id, false);
      return this.replace(id, row => row.jobs.length > 0 && row.jobs.every(job => job.status === "confirmed") ? { ...row, status: "completed", control: "pause", updatedAt: now() } : row);
    });
  }

  private async run(id: string) {
    await this.reconcilePending(id, true);
    let campaign = await this.get(id);
    const candidates = campaign.jobs.filter(job => job.status === "ready");
    // Join every in-flight task before releasing the vault lock, even on errors.
    for (let offset = 0; offset < candidates.length; offset += campaign.input.concurrency) {
      if ((await this.get(id)).control !== "run") break;
      const results = await Promise.allSettled(candidates.slice(offset, offset + campaign.input.concurrency).map(job => this.executeJob(id, job.id)));
      if (results.some(result => result.status === "rejected")) break;
    }
    campaign = await this.get(id);
    if (campaign.control === "run") await this.replace(id, row => ({ ...row, status: row.jobs.every(job => job.status === "confirmed") ? "completed" : "partial", control: "pause", updatedAt: now() }));
  }

  private async reconcilePending(id: string, rebroadcast: boolean) {
    const campaign = await this.get(id);
    const { client, chain } = await this.studio.chainConnection(campaign.input.network);
    for (const job of campaign.jobs.filter(job => hasAttempt(job) && pendingStates.includes(job.status))) {
      const attempt = job.attempts.at(-1);
      if (!attempt || !job.txHash || attempt.hash !== job.txHash) throw new StudioError("Transaction journal is inconsistent. Do not retry this wallet.");
      let receipt: TransactionReceipt | undefined;
      try { receipt = await client.getTransactionReceipt({ hash: attempt.hash }); } catch { /* Missing is not failed. */ }
      if (!receipt && rebroadcast && (await this.get(id)).control === "run") {
        try {
          const signed = this.studio.openForSession(attempt.encryptedSignedTransaction, attempt.iv, attempt.salt) as Hex;
          if (!signed.startsWith("0x02")) throw new Error("Expected EIP-1559 recovery transaction");
          const transaction = parseTransaction(signed);
          const signer = await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` });
          if (keccak256(signed) !== attempt.hash || signer.toLowerCase() !== job.wallet.toLowerCase() || transaction.chainId !== chain.id || transaction.to?.toLowerCase() !== mintTarget(campaign.input).toLowerCase() || transaction.data !== job.calldata || (transaction.value ?? 0n) !== BigInt(job.valueWei) || transaction.nonce !== attempt.nonce) throw new Error("Journal mismatch");
          this.assertCanSend(campaign);
          const hash = await client.sendRawTransaction({ serializedTransaction: signed });
          if (hash !== attempt.hash) throw new Error("Hash mismatch");
        } catch { /* Preserve the original hash even for an ambiguous broadcast. */ }
        try { receipt = await client.waitForTransactionReceipt({ hash: attempt.hash, confirmations: campaign.input.confirmations, timeout: 45_000 }); } catch { /* Reconcile later. */ }
      }
      if (receipt) {
        try { await this.finishReceipt(campaign, job, receipt); continue; } catch { /* Keep reservation until verification succeeds. */ }
      }
      // An audit-write failure after atomic settlement must not undo the result.
      if ((await this.get(id)).jobs.find(item => item.id === job.id)?.actualFeeWei !== undefined) continue;
      await this.patchJob(id, job.id, { status: "unresolved", reason: "Transaction outcome or confirmations are unresolved. Reconcile the existing hash; this wallet will not be signed again." });
    }
  }

  private async executeJob(id: string, jobId: string) {
    const campaign = await this.get(id);
    const job = campaign.jobs.find(item => item.id === jobId);
    if (!job || job.status !== "ready" || hasAttempt(job) || campaign.control !== "run") return;
    try {
      await this.assertNoOtherAttempt(campaign, job.wallet);
      await this.checkGenesis(campaign.input, job.wallet);
      const connection = await this.studio.chainConnection(campaign.input.network);
      const quote = await this.quote(campaign.input, job.wallet, job.calldata, connection);
      if (quote.balance < quote.required || quote.estimatedFee > BigInt(campaign.input.maxFeePerWalletWei)) {
        await this.patchJob(id, jobId, { status: quote.balance < quote.required ? "underfunded" : "blocked", reason: "Balance or total fees changed since review. No transaction was signed." });
        return;
      }
      const reserved = BigInt(job.valueWei) + BigInt(campaign.input.maxFeePerWalletWei);
      if (!await this.reserve(id, jobId, reserved)) return;
      const account = await this.studio.getAccount(job.wallet);
      if ((await this.get(id)).control !== "run") { await this.releaseUnsigned(id, jobId, "ready"); return; }
      this.assertCanSend(campaign);
      const signed = await account.signTransaction(quote.request);
      const hash = keccak256(signed);
      const sealed = this.studio.sealForSession(signed);
      const attempt: TransactionAttempt = { id: randomUUID(), createdAt: now(), nonce: quote.request.nonce, hash, encryptedSignedTransaction: sealed.ciphertext, iv: sealed.iv, salt: sealed.salt };
      // Durable identity precedes broadcast. Never erase it on a timeout.
      await this.patchJob(id, jobId, { status: "signed", txHash: hash, attempts: [attempt] });
      if ((await this.get(id)).control !== "run") return;
      this.assertCanSend(campaign);
      const returned = await connection.client.sendRawTransaction({ serializedTransaction: signed });
      if (returned !== hash) throw new Error("RPC hash mismatch");
      attempt.submittedAt = now();
      await this.patchJob(id, jobId, { status: "submitted", attempts: [attempt] });
      const receipt = await connection.client.waitForTransactionReceipt({ hash, confirmations: campaign.input.confirmations, timeout: 45_000 });
      await this.finishReceipt(campaign, { ...job, txHash: hash }, receipt);
    } catch (error) {
      const latest = (await this.get(id)).jobs.find(item => item.id === jobId)!;
      if (latest.actualFeeWei !== undefined) return;
      if (hasAttempt(latest)) await this.patchJob(id, jobId, { status: "unresolved", reason: "Submission outcome is unresolved. Use Reconcile transactions; no new transaction will be created." });
      else {
        await this.releaseUnsigned(id, jobId, "blocked");
        const classified = classifySimulationError(error);
        await this.patchJob(id, jobId, { status: classified.status, reason: error instanceof StudioError ? error.message : classified.reason });
      }
    }
  }

  private async finishReceipt(campaign: MintCampaign, job: MintJob, receipt: TransactionReceipt) {
    if (receipt.transactionHash !== job.txHash) throw new StudioError("Receipt hash does not match the journal.");
    const { client } = await this.studio.chainConnection(campaign.input.network);
    const [head, block] = await Promise.all([client.getBlockNumber({ cacheTime: 0 }), client.getBlock({ blockNumber: receipt.blockNumber })]);
    if (block.hash !== receipt.blockHash || head < receipt.blockNumber + BigInt(campaign.input.confirmations - 1)) throw new StudioError("Receipt is not canonical at the requested confirmation depth.");
    let fee = receipt.gasUsed * receipt.effectiveGasPrice;
    if (campaign.input.network !== "local") {
      const l1Fee = (receipt as TransactionReceipt & { l1Fee?: bigint | null }).l1Fee;
      if (typeof l1Fee !== "bigint") throw new StudioError("RPC omitted the Base L1 fee. Keep this transaction reserved until it can be reconciled.");
      fee += l1Fee + await client.readContract({ address: oracle, abi: oracleAbi, functionName: "getOperatorFee", args: [receipt.gasUsed], blockNumber: receipt.blockNumber });
    }
    const success = receipt.status === "success";
    const minted = success ? decodeMintAmounts(campaign.input.standard, job.wallet, receipt, campaign.input.contract) : new Map<string, bigint>();
    const tokenIds = [...minted.keys()];
    let verified = success && [...minted.values()].reduce((sum, quantity) => sum + quantity, 0n) === BigInt(campaign.input.quantity);
    if (verified && campaign.input.standard === "ERC721") {
      const owners = await Promise.all(tokenIds.map(tokenId => client.readContract({ address: campaign.input.contract, abi: collectionAbi, functionName: "ownerOf", args: [BigInt(tokenId)], blockNumber: receipt.blockNumber })));
      verified = owners.every(owner => owner.toLowerCase() === job.wallet.toLowerCase());
    }
    if (verified && campaign.input.standard === "ERC1155") {
      const balances = await Promise.all(tokenIds.map(tokenId => client.readContract({ address: campaign.input.contract, abi: erc1155BalanceAbi, functionName: "balanceOf", args: [job.wallet, BigInt(tokenId)], blockNumber: receipt.blockNumber })));
      verified = balances.every((balance, index) => balance >= minted.get(tokenIds[index])!);
    }
    const withinBudget = fee <= BigInt(campaign.input.maxFeePerWalletWei);
    await this.replace(campaign.id, row => {
      const stored = row.jobs.find(item => item.id === job.id)!;
      if (stored.actualFeeWei !== undefined) return row;
      const reserved = BigInt(stored.reservedWei ?? "0");
      if (BigInt(row.reservedWei) < reserved) throw new StudioError("Reservation journal is inconsistent.");
      return { ...row, reservedWei: (BigInt(row.reservedWei) - reserved).toString(), spentWei: (BigInt(row.spentWei) + fee + (success ? BigInt(job.valueWei) : 0n)).toString(), updatedAt: now(), jobs: row.jobs.map(item => item.id !== job.id ? item : {
        ...item, status: !success ? "reverted" : verified && withinBudget ? "confirmed" : "blocked", actualFeeWei: fee.toString(), reservedWei: "0", blockNumber: receipt.blockNumber.toString(), tokenIds, tokenQuantities: Object.fromEntries([...minted].map(([id, quantity]) => [id, quantity.toString()])),
        attempts: item.attempts.map(attempt => attempt.hash === receipt.transactionHash ? { ...attempt, receiptBlockHash: receipt.blockHash } : attempt),
        reason: !success ? "Transaction reverted. It will not be automatically retried." : !verified ? "Transaction succeeded but the expected collection mint/ownership was not verified. Do not mint again." : !withinBudget ? "Mint verified, but actual Base fees exceeded the reviewed ceiling. Inspect the receipt." : undefined, error: undefined, updatedAt: now(),
      }) };
    });
    await this.audit.update(rows => [...rows, { id: randomUUID(), campaignId: campaign.id, revision: campaign.revision, at: now(), type: verified ? "mint-confirmed" : "mint-not-verified", wallet: job.wallet, detail: { hash: receipt.transactionHash, feeWei: fee.toString() } }]);
  }

  private async reserve(id: string, jobId: string, amount: bigint) {
    let ok = false;
    await this.replace(id, row => {
      const job = row.jobs.find(item => item.id === jobId);
      if (!job || hasAttempt(job) || job.status !== "ready" || row.control !== "run") return row;
      if (BigInt(row.spentWei) + BigInt(row.reservedWei) + amount > BigInt(row.input.spendCeilingWei)) throw new StudioError("Campaign spend ceiling has no remaining budget.");
      ok = true;
      return { ...row, reservedWei: (BigInt(row.reservedWei) + amount).toString(), jobs: row.jobs.map(item => item.id === jobId ? { ...item, status: "preflight", reservedWei: amount.toString() } : item), updatedAt: now() };
    });
    return ok;
  }

  private async releaseUnsigned(id: string, jobId: string, status: MintJob["status"]) {
    await this.replace(id, row => {
      const job = row.jobs.find(item => item.id === jobId)!;
      if (hasAttempt(job)) return row;
      return { ...row, reservedWei: (BigInt(row.reservedWei) - BigInt(job.reservedWei ?? "0")).toString(), jobs: row.jobs.map(item => item.id === jobId ? { ...item, reservedWei: "0", status } : item) };
    });
  }

  private async assertNoOtherAttempt(campaign: MintCampaign, wallet: Address) {
    if (campaign.input.network === "mainnet") await this.studio.funding.assertNoPending(wallet);
    await this.studio.assertNoPendingTransfers(campaign.input.network, [wallet]);
    const conflict = (await this.campaigns.read()).some(row => row.id !== campaign.id && row.input.network === campaign.input.network && row.jobs.some(job => job.wallet.toLowerCase() === wallet.toLowerCase() && hasAttempt(job) && (pendingStates.includes(job.status) || row.input.contract.toLowerCase() === campaign.input.contract.toLowerCase())));
    if (conflict) throw new StudioError("Another campaign already signed a mint for this wallet/collection or has a pending transaction. Inspect its recorded hash first.");
  }

  private async patchJob(id: string, jobId: string, patch: Partial<MintJob>) {
    await this.replace(id, row => ({ ...row, jobs: row.jobs.map(job => job.id === jobId ? { ...job, ...patch, updatedAt: now() } : job), updatedAt: now() }));
  }

  private async replace(id: string, mutate: (campaign: MintCampaign) => MintCampaign): Promise<MintCampaign> {
    let result!: MintCampaign;
    await this.campaigns.update(rows => rows.map(row => row.id === id ? (result = mutate(row)) : row));
    if (!result) throw new StudioError("Mint campaign not found.");
    return result;
  }

  private normalize(input: MintCampaignInput): MintCampaignInput {
    const normalized = structuredClone({ ...input, name: input.name.trim(), contract: getAddress(input.contract), wallets: input.wallets.map(value => getAddress(value)), walletArguments: input.walletArguments ?? {} });
    validateCampaignInput(normalized);
    return normalized;
  }

  private async assertWallets(wallets: readonly Address[]) {
    const managed = new Set((await this.studio.metadata()).wallets.map(wallet => wallet.address.toLowerCase()));
    if (wallets.some(wallet => !managed.has(wallet.toLowerCase()))) throw new StudioError("Every selected minting wallet must belong to this vault.");
  }
}
