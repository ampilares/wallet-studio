import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, encodeFunctionData, formatEther, formatUnits, parseUnits, zeroAddress, parseAbi, type Chain, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { anvil, baseSepolia } from "viem/chains";
import { StudioService, StudioError } from "../studio/service.js";
import { RpcManager } from "../chain/RpcManager.js";
import { GasManager } from "../chain/GasManager.js";
import { NonceManager } from "../wallet/NonceManager.js";
import { BundleRepository, TransactionRepository } from "../database/repositories.js";
import { ExecutionEngine } from "../core/ExecutionEngine.js";
import { Simulator } from "../simulation/Simulator.js";
import type { AppConfig } from "../config.js";
import type { Bundle, BundleAction } from "../types.js";
import { protocolAbi } from "./abi.js";
import type { CurvePreview, CurveRequest, CurveView } from "./types.js";

import { previewPayment, purchaseAbi, type RoutedPayment } from "./payments.js";

export type Deployment = { chainId: number; deployer: Address; teamSafe: Address; token: Address; quoteToken: Address; launchCurve: Address; poolManager: Address; epochVault: Address; tombstoneVault: Address; [key: string]: string | number | boolean };
const units = (n: bigint) => formatUnits(n, 8);
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
type Plan = { route?: RoutedPayment; view: CurvePreview; input: CurveRequest; fingerprint: string; amounts: bigint[]; minimums: bigint[] };

export class CurveService {
  readonly client: PublicClient;
  readonly admin: WalletClient;
  runId = randomUUID();
  busy = false;
  phase = "Ready to prepare test funds";
  error: string | null = null;
  report?: CurveView["report"];
  private plans = new Map<string, Plan>();
  private snapshot?: Hex;
  private codeHashes = new Map<Address, Hex>();
  private nodeIdentity?: string;
  private runTests?: () => Promise<void>;
  constructor(readonly studio: StudioService, readonly deployment: Deployment, readonly directory: string, readonly rpcUrl: string, readonly browserWallet: Address, readonly website = "http://127.0.0.1:3001/launchpad", readonly sepoliaAdmin?: StudioService) {
    const url = new URL(rpcUrl);
    if (sepoliaAdmin) {
      if (deployment.chainId !== 84532 || !["https:", "http:"].includes(url.protocol) || (url.protocol === "http:" && url.hostname !== "127.0.0.1")) throw new Error("Sepolia testing requires chain 84532 and HTTPS RPC");
    } else if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || deployment.chainId !== 31337) throw new Error("Curve testing is local only");
    const transport = http(rpcUrl, { retryCount: 0, timeout: 5000 });
    this.client = createPublicClient({ chain: this.chain, transport, pollingInterval: this.sepoliaAdmin ? 1000 : 100 });
    this.admin = createWalletClient({ chain: this.chain, transport, account: deployment.deployer });
  }
  get chain(): Chain { return this.sepoliaAdmin ? baseSepolia : anvil; }
  stopped = false;
  get dataDir() { return path.join(this.directory, "runs", this.runId); }
  get repository() { return new BundleRepository(this.dataDir); }
  async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    if (this.sepoliaAdmin && /^(anvil_|evm_)/.test(method)) throw new StudioError("Local chain controls are unavailable on Sepolia.");
    const response = await fetch(this.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(5000) });
    const body = await response.json() as { result: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
  async read<T>(address: Address, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return await this.client.readContract({ address, abi: protocolAbi as Abi, functionName, args }) as T;
  }
  async readMany(calls: {address:Address; functionName:string; args?:readonly unknown[]}[]): Promise<unknown[]> {
    if(!this.sepoliaAdmin)return Promise.all(calls.map(c=>this.read(c.address,c.functionName,c.args)));
    return this.client.multicall({allowFailure:false,batchSize:16384,contracts:calls.map(c=>({...c,abi:protocolAbi as Abi}))});
  }
  async verify() {
    if (await this.client.getChainId() !== this.chain.id) throw new StudioError("Wrong RPC chain. No transactions sent.");
    if (!this.sepoliaAdmin) {
    if (await this.client.getChainId() !== 31337 || !(await this.rpc<string>("web3_clientVersion")).toLowerCase().includes("anvil")) throw new StudioError("The dedicated Anvil test chain is unavailable.");
    const metadata = await this.rpc<{ instanceId: string }>("anvil_metadata");
    if (!metadata.instanceId) throw new StudioError("Anvil did not provide a test-chain identity.");
    if (this.nodeIdentity && this.nodeIdentity !== metadata.instanceId) throw new StudioError("The test chain restarted. Restart the curve stack to load its new deployment.");
    this.nodeIdentity = metadata.instanceId;
    }
    const d = this.deployment;
    for (const address of [d.token, d.quoteToken, d.launchCurve, d.poolManager]) {
      const code = await this.client.getCode({ address });
      if (!code || code === "0x" || (this.codeHashes.has(address) && this.codeHashes.get(address) !== code)) throw new StudioError("Deployment code changed or is missing.");
      this.codeHashes.set(address, code);
    }
    const links=[["token", d.token], ["cbBTC", d.quoteToken], ["graduationManager", d.poolManager], ["quoteFeeRecipient", d.epochVault]] as const;
    const results=await this.readMany([...links.map(([name])=>({address:d.launchCurve,functionName:name})),...[d.token,d.quoteToken].map(address=>({address,functionName:"decimals"}))]);
    for(const [i,[,expected]] of links.entries())if((results[i] as Address).toLowerCase()!==expected.toLowerCase())throw new StudioError("Deployment relationship mismatch.");
    if(results[4]!==8||results[5]!==8)throw new StudioError("Unexpected token decimals.");
  }
  async adminCall(address: Address, functionName: string, args: readonly unknown[] = []) {
    await this.verify();
    const hash = await this.admin.writeContract({ address, abi: protocolAbi as Abi, functionName, args, account: this.sepoliaAdmin ? await this.sepoliaAdmin.getAccount(this.deployment.deployer) : this.deployment.deployer, chain: this.chain });
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 20_000 });
    if (receipt.status !== "success") throw new StudioError("Local setup transaction reverted.");
    return receipt;
  }
  async initialize() { await this.verify(); if (this.sepoliaAdmin) this.runId = this.deployment.launchCurve.toLowerCase() as typeof this.runId; else this.snapshot = await this.rpc<Hex>("evm_snapshot"); }
  async prepare() {
    await this.verify();
    if (this.sepoliaAdmin) throw new StudioError("Use Sepolia setup to fund and open this deployment.");
    const wallets = (await this.studio.backup()).wallets;
    if (wallets.length !== 10) throw new StudioError("The curve fixture requires exactly ten wallets.");
    for (const address of [...wallets.map(w => w.address), this.browserWallet]) {
      const eth = await this.client.getBalance({ address });
      if (eth < 10n ** 19n) await this.rpc("anvil_setBalance", [address, "0x8ac7230489e80000"]);
      const balance = await this.read<bigint>(this.deployment.quoteToken, "balanceOf", [address]);
      if (balance < 100_000_000n) await this.adminCall(this.deployment.quoteToken, "faucet", [address, 100_000_000n - balance]);
    }
    if (!await this.read<boolean>(this.deployment.launchCurve, "tradingOpen")) await this.adminCall(this.deployment.launchCurve, "open");
    this.phase = "Ten wallets funded. The BTC69K Launchpad is ready.";
  }
  async reset() {
    if (this.sepoliaAdmin) throw new StudioError("Sepolia cannot rewind. Create a new deployment for a fresh guard window.");
    await this.verify();
    if (!this.snapshot || !await this.rpc<boolean>("evm_revert", [this.snapshot])) throw new StudioError("The fixture snapshot expired. Restart the curve stack.");
    this.snapshot = await this.rpc<Hex>("evm_snapshot");
    this.runId = randomUUID(); this.plans.clear(); this.report = undefined; this.error = null;
    await this.prepare();
  }
  async state(): Promise<CurveView> {
    await this.verify();
    if (!this.busy) {
      // Receipt reconciliation is read-only on chain and never resubmits a trade.
      for (const bundle of await this.repository.list()) {
        let changed = false;
        for (const action of bundle.actions) {
          if (!action.txHash || ["CONFIRMED", "REVERTED", "CANCELLED"].includes(action.status)) continue;
          try {
            const receipt = await this.client.getTransactionReceipt({ hash: action.txHash });
            action.status = receipt.status === "success" ? "CONFIRMED" : "REVERTED";
            action.blockNumber = String(receipt.blockNumber); action.gasUsed = String(receipt.gasUsed); changed = true;
          } catch { /* Keep unresolved identity until an actual receipt is available. */ }
        }
        if (changed) {
          bundle.status = bundle.actions.every(a => a.status === "CONFIRMED") ? "COMPLETED" : "PARTIAL";
          await this.repository.save(bundle);
        }
      }
    }
    const d = this.deployment;
    const values=await this.readMany(["walletGuardCap","guardBlocks","guardEndBlock","tradingOpen","graduated","canGraduate","quoteReserve","tokenReserve","graduationTarget"].map(functionName=>({address:d.launchCurve,functionName})));
    const [cap,guardBlocks,end,open,graduated,canGraduate,quoteReserve,tokenReserve,target]=values as [bigint,number,bigint,boolean,boolean,boolean,bigint,bigint,bigint];
    const block = await this.client.getBlockNumber({ cacheTime: 0 });
    const wallets = (await this.studio.metadata()).wallets;
    const balances=await this.readMany(wallets.flatMap(w=>[
      {address:d.quoteToken,functionName:"balanceOf",args:[w.address]},
      {address:d.token,functionName:"balanceOf",args:[w.address]},
      {address:d.launchCurve,functionName:"guardPurchased",args:[w.address]},
      {address:d.quoteToken,functionName:"allowance",args:[w.address,graduated?d.poolManager:d.launchCurve]},
    ]));
    const multicall=this.chain.contracts?.multicall3?.address;
    const ethBalances=this.sepoliaAdmin && multicall ? await this.client.multicall({allowFailure:false,contracts:wallets.map(w=>({address:multicall,abi:parseAbi(["function getEthBalance(address) view returns (uint256)"]),functionName:"getEthBalance",args:[w.address]}))}) as bigint[] : await Promise.all(wallets.map(w=>this.client.getBalance({address:w.address})));
    const rows=wallets.map((w,i)=>{
      const [quote,token,purchased,allowance]=balances.slice(i*4,i*4+4) as bigint[];
      return {address:w.address,label:w.label,eth:formatEther(ethBalances[i]),quote:units(quote),token:units(token),guardPurchased:units(purchased),guardRemaining:units(cap>purchased?cap-purchased:0n),allowance:units(allowance)};
    });
    return { paymentsEnabled:!!this.deployment.purchaseRouter, network: this.sepoliaAdmin ? "sepolia" : "local", runId: this.runId, busy: this.busy, phase: this.phase, error: this.error, website: this.website, browserWallet: this.browserWallet,
      open, graduated, canGraduate, quoteReserve: units(quoteReserve), tokenReserve: units(tokenReserve), target: units(target), wallets: rows,
      guard: { cap: units(cap), blocks: guardBlocks, endBlock: String(end), remainingBlocks: String(end === 0n ? guardBlocks : end > block ? end - block : 0n), active: guardBlocks > 0 && !graduated && (end === 0n || block < end) },
      bundles: (await this.repository.list()).slice(-20).reverse().map(b => ({ id: b.id, name: b.name, status: b.status, actions: b.actions.map(a => ({ walletAddress: a.walletAddress, status: a.status, txHash: a.txHash, blockNumber: a.blockNumber })) })), report: this.report };
  }
  private async market() {
    const d = this.deployment;
    const graduated = await this.read<boolean>(d.launchCurve, "graduated");
    let q = await this.read<bigint>(d.launchCurve, "quoteReserve"), t = await this.read<bigint>(d.launchCurve, "tokenReserve");
    const v = graduated ? 0n : await this.read<bigint>(d.launchCurve, "virtualQuoteReserve");
    const target = await this.read<bigint>(d.launchCurve, "graduationTarget");
    const poolId = await this.read<Hex>(d.launchCurve, "graduatedPoolId");
    if (graduated) { const pool = await this.read<readonly [Address, Address, bigint, bigint, boolean]>(d.poolManager, "pools", [poolId]); q = pool[3]; t = pool[2]; }
    const k = graduated ? q * t : await this.read<bigint>(d.launchCurve, "invariantK");
    return { graduated, q, t, v, target, k, poolId, fingerprint: `${this.runId}:${graduated}:${q}:${t}` };
  }
  async preview(input: CurveRequest): Promise<CurvePreview> {
    await this.verify();
    const owned = (await this.studio.backup()).wallets.map(w => w.address);
    const selected = [...new Set(input.wallets)];
    if (!selected.length || selected.length > 10 || selected.some(a => !owned.includes(a as Address))) throw new StudioError("Select between one and ten fixture wallets.");
    if(input.payment && input.payment !== "cbBTC") {
      if ((await this.repository.list()).some(b => b.actions.some(a => a.txHash && !["CONFIRMED", "REVERTED", "CANCELLED"].includes(a.status)))) throw new StudioError("Resolve earlier submissions first.");
      const m=await this.market();
      const {view,route,amount,minimum}=await previewPayment(this,input,selected);
      this.plans.clear();this.plans.set(view.id,{view,input:{...input,wallets:selected},fingerprint:m.fingerprint,amounts:selected.map(()=>amount),minimums:selected.map(()=>minimum),route});
      return view;
    }
    if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(input.amount)) throw new StudioError("Use a positive amount with at most eight decimals.");
    const amount = parseUnits(input.amount, 8);
    if (input.operation !== "graduate" && amount <= 0n) throw new StudioError("Amount must be positive.");
    const m = await this.market();
    if (input.operation === "graduate" && (selected.length !== 1 || !await this.read<boolean>(this.deployment.launchCurve, "canGraduate"))) throw new StudioError("Select one wallet after the graduation target is reached.");
    if (input.operation !== "graduate" && !m.graduated && (!await this.read<boolean>(this.deployment.launchCurve, "tradingOpen") || m.q >= m.target)) throw new StudioError("Curve trading is closed.");
    if ((await this.repository.list()).some(b => b.actions.some(a => a.txHash && !["CONFIRMED", "REVERTED", "CANCELLED"].includes(a.status)))) throw new StudioError("An earlier submission is unresolved. Check its receipt before another trade.");
    let q = m.q, t = m.t, first = 0n, worst = 0n;
    for (let i = 0; i < selected.length; i++) {
      if (input.operation === "graduate") break;
      if (input.operation === "buy") {
        const spent = m.graduated ? amount : q >= m.target ? 0n : [amount, (m.target - q - 1n) * 10000n / 9500n + 1n].reduce((a,b) => a < b ? a : b);
        const nextQ = q + spent - spent * 500n / 10000n;
        const nextT = ceil(m.graduated ? q * t : m.k, m.v + nextQ);
        worst = t - nextT; q = nextQ; t = nextT;
      } else {
        const nextT = t + amount - amount * 500n / 10000n;
        const nextQ = ceil(m.graduated ? q * t : m.k, nextT) - m.v;
        worst = q - nextQ; q = nextQ; t = nextT;
      }
      if (!i) first = worst;
    }
    if (m.graduated && this.sepoliaAdmin && input.operation !== "graduate") {
      const quote = await this.client.simulateContract({ address: this.deployment.poolManager, abi: protocolAbi as Abi, functionName: "quoteExactInput", args: [input.operation === "buy", amount] });
      first = worst = quote.result as bigint;
    }
    const minimum = input.operation === "graduate" ? 0n : (input.tight ? first : worst) * 99n / 100n;
    if (input.operation === "sell" && worst <= 0n) throw new StudioError("Sell amount exceeds available curve reserves.");
    for (const wallet of selected) {
      if (await this.client.getBalance({ address: wallet as Address }) < (this.sepoliaAdmin ? 300_000_000_000_000n : 2_000_000_000_000_000n)) throw new StudioError(this.sepoliaAdmin ? "A selected wallet needs more Sepolia ETH for gas." : "A selected wallet needs local ETH for gas.");
      const asset = input.operation === "sell" ? this.deployment.token : this.deployment.quoteToken;
      if (input.operation !== "graduate" && await this.read<bigint>(asset, "balanceOf", [wallet]) < amount) throw new StudioError("A selected wallet has insufficient input tokens.");
    }
    const gasPrice = await this.client.estimateFeesPerGas();
    const view: CurvePreview = { id: randomUUID(), expiresAt: Date.now() + 120000, operation: input.operation, venue: m.graduated ? this.sepoliaAdmin ? "Uniswap v4 (Sepolia)" : "Local mock AMM" : "Bonding curve", amount: input.amount, total: units(amount * BigInt(selected.length)), maximumGasEth: formatEther(2_000_000n * BigInt(selected.length) * (gasPrice.maxFeePerGas ?? 0n)), rows: selected.map(address => ({ address, expected: units(first), minimum: units(minimum > 0n ? minimum : input.operation === "graduate" ? 0n : 1n) })) };
    this.plans.clear();
    this.plans.set(view.id, { view, input: { ...input, wallets: selected }, fingerprint: m.fingerprint, amounts: selected.map(() => amount), minimums: selected.map(() => minimum > 0n ? minimum : 1n) });
    return view;
  }
  async bundle(name: string, actions: Omit<BundleAction, "id" | "status">[], simultaneous = false): Promise<Bundle> {
    await this.verify();
    const config: AppConfig = { network: this.sepoliaAdmin ? "sepolia" : "local", mode: "live", rpcUrl: this.rpcUrl, rpcUrlSecondary: "", wsUrl: "", alchemyApiKey: "", walletPassphrase: "", maxConcurrency: 10, minGasEth: this.sepoliaAdmin ? 0.0002 : 0.002, defaultSlippageBps: 100, dataDir: this.dataDir, useSequencer: false, sequencerUrl: "" };
    const rpc = new RpcManager(config, true);
    const wallets = { getAccount: (address: Address) => this.studio.getAccount(address), getBalance: (address: Address) => this.client.getBalance({ address }), fundWallet: async () => { throw new Error("Use local fixture funding"); } };
    const gas = new GasManager(config, rpc, wallets);
    const repo = this.repository;
    const bundle: Bundle = { id: randomUUID(), chainId: this.chain.id, name, mode: "live", status: "CREATED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), wallets: actions.map(a => a.walletAddress), actions: actions.map(a => ({ ...a, id: randomUUID(), status: "CREATED" })), gasPlan: { gasLimitBufferBps: 10000 } };
    await repo.save(bundle);
    const estimates = new Map<string, bigint>();
    // Anvil estimates against pending state. Freeze estimates before any member of
    // a simultaneous batch enters the mempool so intentional slippage reverts
    // still reach the chain instead of being rejected by a later estimate.
    if (simultaneous && !this.sepoliaAdmin) for (const action of bundle.actions) estimates.set(action.id, await this.client.estimateGas({ account: action.walletAddress, to: action.target!, data: action.calldata!, value: 0n, blockTag: "latest" }));
    const engine = new ExecutionEngine(config, rpc, gas, wallets, new NonceManager(rpc), new Simulator(config, rpc, gas, wallets, repo), repo, new TransactionRepository(this.dataDir), undefined, simultaneous && !this.sepoliaAdmin ? estimates : undefined);
    if (!simultaneous || this.sepoliaAdmin) return engine.executeBundle(bundle.id);
    await this.rpc("evm_setAutomine", [false]);
    let result: Bundle | undefined, failure: unknown, finished = false;
    const execution = engine.executeBundle(bundle.id).then(b => { result = b; }, e => { failure = e; }).finally(() => { finished = true; });
    try {
      const deadline = Date.now() + 25000;
      while (!finished && Date.now() < deadline) {
        const current = await repo.get(bundle.id);
        if (current?.actions.every(a => ["SUBMITTED", "CONFIRMED", "REVERTED", "SUBMISSION_FAILED", "SIMULATION_FAILED", "INSUFFICIENT_GAS"].includes(a.status))) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await this.rpc("evm_mine");
    } finally { await this.rpc("evm_setAutomine", [true]); }
    await execution;
    if (failure) throw failure;
    return result!;
  }
  async execute(id: string) {
    const plan = this.plans.get(id); this.plans.delete(id);
    if (!plan || Date.now() > plan.view.expiresAt) throw new StudioError("Review expired or already used.");
    const m = await this.market();
    if (m.fingerprint !== plan.fingerprint) throw new StudioError("Market changed. Review again before sending.");
    const d = this.deployment, spender = plan.route ? d.purchaseRouter as Address : m.graduated ? d.poolManager : d.launchCurve;
    const asset = plan.route ? plan.route.payment : plan.input.operation === "sell" ? d.token : d.quoteToken;
    const approvals: Omit<BundleAction, "id" | "status">[] = [];
    for (const [i, wallet] of plan.input.wallets.entries()) {
      if (asset !== zeroAddress && plan.input.operation !== "graduate" && await this.read<bigint>(asset, "allowance", [wallet, spender]) < plan.amounts[i]) approvals.push({ type: "APPROVE", walletAddress: wallet as Address, target: asset, valueWei: "0", calldata: encodeFunctionData({ abi: protocolAbi, functionName: "approve", args: [spender, plan.amounts[i]] }) });
    }
    if (approvals.length) {
      this.phase = "Confirming exact-amount approvals";
      const approved = await this.bundle("Approve input tokens", approvals);
      if (approved.actions.some(a => a.status !== "CONFIRMED")) throw new StudioError("Approval failed. No dependent trades were sent.");
    }
    if ((await this.market()).fingerprint !== plan.fingerprint) throw new StudioError("Market changed during approval. Review again.");
    if(Date.now()>plan.view.expiresAt)throw new StudioError("Quote expired during approval. Review again.");
    if(plan.route){
      const route=plan.route;
      const actions=plan.input.wallets.map((wallet,i)=>({type:"CONTRACT_CALL" as const,walletAddress:wallet as Address,target:spender,valueWei:route.payment===zeroAddress?plan.amounts[i].toString():"0",calldata:encodeFunctionData({abi:purchaseAbi,functionName:"buy",args:[route.payment,plan.amounts[i],route.path,route.minQuote,plan.minimums[i],route.deadline,route.graduated]})}));
      const result=await this.bundle(`Routed buy · ${plan.input.payment} · ${actions.length} wallets`,actions,true);
      this.phase=`${result.actions.filter(a=>a.status==="CONFIRMED").length}/${actions.length} routed trades confirmed. See receipts.`;
      return result;
    }
    this.phase = "Submitting trades together and mining their receipts";
    const actions = plan.input.wallets.map((wallet, i) => ({ type: "CONTRACT_CALL" as const, walletAddress: wallet as Address, target: spender, valueWei: "0", calldata: encodeFunctionData({ abi: protocolAbi as Abi, functionName: m.graduated && this.sepoliaAdmin ? "swapExactInput" : plan.input.operation, args: plan.input.operation === "graduate" ? [] : m.graduated && this.sepoliaAdmin ? [plan.input.operation === "buy", plan.amounts[i], plan.minimums[i], BigInt(Math.floor(Date.now()/1000)+120)] : m.graduated ? [m.poolId, plan.amounts[i], plan.minimums[i]] : [plan.amounts[i], plan.minimums[i]] }) }));
    const result = await this.bundle(`${plan.input.operation} Â· ${actions.length} wallets Â· ${plan.view.venue}`, actions, true);
    this.phase = `${result.actions.filter(a => a.status === "CONFIRMED").length}/${actions.length} trades confirmed. See individual receipts.`;
    return result;
  }
  setTestRunner(runner: () => Promise<void>) { this.runTests = runner; }
  start(action: "prepare" | "reset" | "execute" | "test" | "cap" | "stop", id?: string) {
    if (action === "stop") { this.stopped = true; return { runId: this.runId }; }
    if (this.busy) throw new StudioError("A curve operation is already running.");
    this.stopped = false;
    this.busy = true; this.error = null;
    void (async () => {
      try {
        if (action === "prepare") await this.prepare();
        else if (action === "reset") await this.reset();
        else if (action === "execute") await this.execute(id!);
        else if (action === "cap") await this.buyToCap();
        else if (this.runTests) await this.runTests();
        else throw new StudioError("Test runner unavailable.");
      } catch (e) { this.error = e instanceof StudioError ? e.message : "Operation failed. Inspect the local test report and transaction statuses."; this.phase = "Stopped"; }
      finally { this.busy = false; }
    })();
    return { runId: this.runId };
  }
  async saveReport() {
    await mkdir(this.dataDir, { recursive: true });
    const state = await this.state();
    await writeFile(path.join(this.dataDir, "report.json"), JSON.stringify(state, null, 2));
    await writeFile(path.join(this.dataDir, "report.md"), `# Curve test report\n\n${this.report?.map(r => `- ${r.passed ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`).join("\n")}\n\nTransactions and balances: report.json\n`);
  }

  async buyToCap() {
    await this.verify();
    const d = this.deployment;
    const wallets = (await this.studio.backup()).wallets.map(w => w.address);
    const cap = await this.read<bigint>(d.launchCurve, "walletGuardCap");
    if ((await this.repository.list()).some(b => b.actions.some(a => !["CONFIRMED", "REVERTED", "CANCELLED"].includes(a.status)))) throw new StudioError("An earlier batch is unresolved. Reconcile its receipts before resuming.");
    if (wallets.length !== 10 || await this.read<number>(d.launchCurve, "guardBlocks") !== 150 || cap !== 34500n * 100000000n)
      throw new StudioError("Restart the local stack to deploy the 150-block / 34,500-token guard.");
    const checkWindow = async () => {
      const end = await this.read<bigint>(d.launchCurve, "guardEndBlock");
      if (end && await this.client.getBlockNumber({ cacheTime: 0 }) + (this.sepoliaAdmin ? 8n : 1n) >= end)
        throw new StudioError("The guard window has ended or is about to end. Reset the test before buying to the cap.");
    };
    await checkWindow();
    if (!await this.read<boolean>(d.launchCurve, "tradingOpen") || await this.read<boolean>(d.launchCurve, "graduated"))
      throw new StudioError("Reset and prepare the curve before running cap buys.");
    // A bounded 0.01 mock-cbBTC budget per wallet covers this fixture's cap.
    const budget = 1000000n;
    const approvals = wallets.map(walletAddress => ({ type: "APPROVE" as const, walletAddress, target: d.quoteToken, valueWei: "0", calldata: encodeFunctionData({ abi: protocolAbi, functionName: "approve", args: [d.launchCurve, budget] }) }));
    const batches: Bundle[] = [];
    try {
      const approved = await this.bundle("Approve cap-run budget (0.01 cbBTC each)", approvals);
      if (approved.actions.some(a => a.status !== "CONFIRMED")) throw new StudioError("Cap-run approval failed.");
      for (let round = 1; round <= 30; round++) {
        if (this.stopped) throw new StudioError("Stopped before the next round. Submitted transactions may still confirm.");
        await checkWindow();
        const m = await this.market();
        if (m.graduated || m.q >= m.target) throw new StudioError("The curve changed during the cap run.");
        const actions: Omit<BundleAction, "id" | "status">[] = [];
        for (const walletAddress of wallets) {
          const purchased = await this.read<bigint>(d.launchCurve, "guardPurchased", [walletAddress]);
          const remaining = cap - purchased;
          // At most a quarter-cap per round. Later positions receive fewer tokens,
          // so these inputs remain below each wallet's cap in any mining order.
          const wanted = remaining < cap / 4n ? remaining : cap / 4n;
          let low = 0n, high = budget;
          while (low < high) {
            const mid = (low + high + 1n) / 2n;
            const output = m.t - ceil(m.k, m.v + m.q + mid - mid * 500n / 10000n);
            if (output <= wanted) low = mid; else high = mid - 1n;
          }
          if (!low) continue;
          actions.push({ type: "CONTRACT_CALL", walletAddress, target: d.launchCurve, valueWei: "0", calldata: encodeFunctionData({ abi: protocolAbi as Abi, functionName: "buy", args: [low, 1n] }) });
        }
        if (!actions.length) {
          this.phase = "10 wallets reached their purchasable cap; any remainder is smaller than one cbBTC unit can buy.";
          this.report = [{ name: "Ten-wallet guard cap", passed: true, detail: this.phase }];
          return batches;
        }
        this.phase = `Cap round ${round}: ${actions.length} wallets buying together`;
        const batch = await this.bundle(`Guard cap Â· round ${round}`, actions, true);
        batches.push(batch);
        if (batch.actions.some(a => a.status !== "CONFIRMED")) throw new StudioError("A cap purchase failed. Inspect the receipts before retrying.");
        for (const wallet of wallets) if (await this.read<bigint>(d.launchCurve, "guardPurchased", [wallet]) > cap)
          throw new StudioError("A wallet exceeded the configured cap.");
      }
      throw new StudioError("Cap run reached its round limit; inspect remaining allowances.");
    } catch (e) {
      this.report = [{ name: "Ten-wallet guard cap", passed: false, detail: e instanceof Error ? e.message : String(e) }];
      throw e;
    } finally {
      const revoked = await this.bundle("Revoke unused cap-run approvals", wallets.map(walletAddress => ({ type: "APPROVE" as const, walletAddress, target: d.quoteToken, valueWei: "0", calldata: encodeFunctionData({ abi: protocolAbi, functionName: "approve", args: [d.launchCurve, 0n] }) })));
      if (revoked.actions.some(a => a.status !== "CONFIRMED")) throw new StudioError("Unable to revoke a cap-run allowance. Inspect approval receipts.");
      await this.saveReport();
    }
  }
}
