import path from "node:path";
import { z } from "zod";
import { formatEther, isAddress, parseEther, parseAbi, type Address } from "viem";
import { StudioService, StudioError } from "../studio/service.js";
import { CurveService, type Deployment } from "../curve/service.js";
import { JsonStore } from "../database/JsonStore.js";
import { SepoliaDeployment } from "./deployment.js";

import { deploymentFailureMessage } from "./deployment-errors.js";
import { fundTestWETH } from "./payment-fixture.js";

export class SepoliaService {
  readonly studio: StudioService;
  readonly admin: StudioService;
  readonly deployer: SepoliaDeployment;
  readonly settings;
  readonly manifest;
  curve?: CurveService;
  busy = false;
  error = "";
  constructor(readonly root: string, readonly directory: string, readonly rpcUrl: string, readonly onReady: (d: Deployment, wallet: Address) => Promise<void> = async () => {}, readonly walletDirectory: string = directory) {
    this.studio = new StudioService(path.join(walletDirectory,"wallets"));
    this.admin = new StudioService(path.join(walletDirectory,"admin"));
    this.deployer = new SepoliaDeployment(root,directory,rpcUrl,this.admin);
    this.settings = new JsonStore<{ browserWallet: Address } | null>(path.join(directory,"settings.json"),null);
    this.manifest = new JsonStore<Deployment | null>(path.join(directory,"deployment.json"),null);
  }
  get reusingWallets() { return path.resolve(this.walletDirectory).toLowerCase() !== path.resolve(this.directory).toLowerCase(); }
  async walletSettings() {
    return await this.settings.read() ?? (this.reusingWallets ? await new JsonStore<{browserWallet:Address}|null>(path.join(this.walletDirectory,"settings.json"),null).read() : null);
  }
  async fundingBudget() {
    const config=await this.walletSettings();
    const wallets=(await this.studio.metadata()).wallets;
    const addresses=[...new Set([...wallets.map(w=>w.address),...(config?[config.browserWallet]:[])])];
    const multicall=this.deployer.client.chain.contracts.multicall3.address;
    const balances=await this.deployer.client.multicall({allowFailure:false,contracts:addresses.map(address=>({address:multicall,abi:parseAbi(["function getEthBalance(address) view returns (uint256)"]),functionName:"getEthBalance",args:[address]}))});
    const topups=balances.reduce((sum,n)=>sum+(n<parseEther("0.003")?parseEther("0.003")-n:0n),0n);
    // New setup reserve covers conversion liquidity, WETH funding and deployment gas.
    return topups+parseEther(await this.manifest.read()?"0.0052":"0.012");
  }
  async state() {
    const vault = await this.studio.metadata(), admin = await this.admin.metadata();
    const address = admin.wallets[0]?.address;
    let balance = "0", networkError = "", requiredBalance = "0";
    try { await this.deployer.checkChain(); if (address) { balance = formatEther(await this.deployer.client.getBalance({address})); requiredBalance = formatEther(await this.fundingBudget()); } }
    catch { networkError = "Cannot reach Base Sepolia. Check the RPC connection."; }
    return { reusingWallets:this.reusingWallets,walletProfile:path.basename(this.walletDirectory),requiredBalance, vaultExists:vault.vaultExists,unlocked:vault.unlocked && admin.unlocked,adminAddress:address,balance,networkError,busy:this.busy,error:this.error,phase:this.busy || this.error ? this.deployer.phase : "Ready",rpcProvider:new URL(this.rpcUrl).hostname,browserWallet:(await this.walletSettings())?.browserWallet,ready:!!this.curve, deployed:!!await this.manifest.read(),wallets:vault.wallets };
  }
  async attach() {
    const d = await this.manifest.read(), config = await this.settings.read();
    if (!d || !config) return;
    this.curve = new CurveService(this.studio,d,this.directory,this.rpcUrl,config.browserWallet,"http://127.0.0.1:3001/launchpad",this.admin);
    await this.curve.initialize();
    await this.onReady(d,config.browserWallet);
  }
  async setup(passphrase: string, browserWallet: Address) {
    if (this.busy || this.curve?.busy) throw new StudioError("Wait for the current operation.");
    const old = await this.walletSettings();
    if (old && old.browserWallet.toLowerCase() !== browserWallet.toLowerCase()) throw new StudioError("Use the original website wallet for this deployment.");
    if(this.reusingWallets && (!(await this.admin.metadata()).vaultExists || !(await this.studio.metadata()).vaultExists)) throw new StudioError("An original vault is missing. Restore it from backup; no replacement wallets were created.");
    try {
      if ((await this.admin.metadata()).vaultExists) await this.admin.unlock(passphrase); else await this.admin.setup(passphrase,1);
      if ((await this.studio.metadata()).vaultExists) await this.studio.unlock(passphrase); else await this.studio.setup(passphrase);
      if(this.reusingWallets && ((await this.studio.metadata()).wallets.length!==10 || (await this.admin.metadata()).wallets.length!==1)) throw new StudioError("Reuse requires exactly ten trading wallets and one deployment wallet.");
    } catch(e) { this.admin.lock();this.studio.lock();throw e; }
    await this.settings.write({browserWallet});
    await this.attach();
  }
  async deployAndFund() {
    const config = await this.settings.read();
    if (!config) throw new StudioError("Set up the vault and website wallet first.");
    const owner = (await this.admin.backup()).wallets[0].address;
    await this.deployer.checkChain();
    const budget=await this.fundingBudget();
    if (await this.deployer.client.getBalance({address:owner}) < budget) throw new StudioError(`The deployment account needs a balance of ${formatEther(budget)} Base Sepolia ETH for setup and any missing wallet funds. Existing wallet balances are reused.`);
    let d = await this.manifest.read();
    if (!d) { d = await this.deployer.deployProtocol(); await this.manifest.write(d); }
    for (const address of [...(await this.studio.backup()).wallets.map(w=>w.address),config.browserWallet]) {
      const eth = await this.deployer.client.getBalance({address});
      if (eth < parseEther("0.003")) await this.deployer.send(`Fund ETH ${address}`,"0x",address,parseEther("0.003")-eth);
      await this.deployer.call("MockCbBTC",d.quoteToken,"faucet",[address,100000000n],`Mint test quote ${address}`);
      if(d.purchaseRouter && d.paymentUSDC) {
        await this.deployer.call("MockUSDC",d.paymentUSDC as Address,"faucet",[address,100000000n],`Mint test USDC ${address}`);
        await fundTestWETH(this.deployer,address);
      }
    }
    await this.attach();
    if (await this.curve!.read<number>(d.launchCurve,"guardBlocks") !== 150 || await this.curve!.read<bigint>(d.launchCurve,"walletGuardCap") !== 3450000000000n) throw new StudioError("Guard verification failed.");
    // Opening does not start the clock. The first successful buy starts it.
    await this.deployer.call("BondingCurve",d.launchCurve,"open");
  }
  requireCurve() { if (!this.curve) throw new StudioError("Deploy and fund the Sepolia contracts first."); return this.curve; }
  async handle(route: string, input: unknown) {
    if (route === "/api/sepolia/state" && input === undefined) return this.state();
    if (route === "/api/sepolia/setup") {
      const data = z.object({passphrase:z.string().min(16).max(512),browserWallet:z.string().refine(isAddress)}).strict().parse(input);
      await this.setup(data.passphrase,data.browserWallet as Address); return {ok:true};
    }
    if (route === "/api/sepolia/lock") { this.admin.lock(); this.studio.lock(); return {ok:true}; }
    if (route === "/api/sepolia/backup") return {walletProfile:path.basename(this.walletDirectory),deploymentProfile:path.basename(this.directory),admin:await this.admin.backup(),wallets:await this.studio.backup(),settings:await this.settings.read(),deployment:await this.manifest.read()};
    if (route === "/api/sepolia/deploy") {
      z.object({confirm:z.literal(true)}).strict().parse(input);
      if (this.busy || this.curve?.busy) throw new StudioError("An operation is already running.");
      if (!this.admin.unlocked || !this.studio.unlocked) throw new StudioError("Unlock the vault first.");
      this.busy = true; this.error = "";
      void this.deployAndFund().catch(async e=>{
        const phase=this.deployer.phase;
        let hash:string|undefined;
        try {hash=(await this.deployer.journal.read())[phase]?.hash;} catch { /* Preserve the original failure. */ }
        this.error = e instanceof StudioError ? e.message : deploymentFailureMessage(phase,e,hash);
        await new JsonStore(path.join(this.directory,"last-deployment-error.json"),{}).write({phase,message:this.error,at:new Date().toISOString()}).catch(()=>{});
      }).finally(()=>{this.busy=false;});
      return {ok:true};
    }
    throw new StudioError("Unknown Sepolia action.");
  }
}
