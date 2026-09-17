import path from "node:path";
import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, encodeDeployData, encodeFunctionData, getContractAddress, keccak256, toHex, type PublicClient, type Transport, type Abi, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { JsonStore } from "../database/JsonStore.js";
import type { StudioService } from "../studio/service.js";
import { StudioError } from "../studio/service.js";
import type { Deployment } from "../curve/service.js";

import { paymentInfrastructure, seedPaymentLiquidity, verifyPaymentInfrastructure } from "./payment-fixture.js";
import { retryDeploymentRead } from "./deployment-errors.js";

export const SEPOLIA_CORE = "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408" as Address;
type Step = { digest: Hex; hash: Hex; address?: Address; confirmed: boolean };
export class SepoliaDeployment {
  readonly client: PublicClient<Transport, typeof baseSepolia>;
  readonly journal;
  phase = "Ready";
  private lastReceiptBlock = 0n;
  constructor(readonly root: string, readonly directory: string, readonly rpcUrl: string, readonly admin: StudioService) {
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) throw new Error("Use HTTPS for Sepolia RPC");
    this.client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl), pollingInterval: 1000 });
    this.journal = new JsonStore<Record<string, Step>>(path.join(directory, "deployment-transactions.json"), {});
  }
  async artifact(name: string): Promise<{ abi: Abi; bytecode: { object: Hex } }> {
    return JSON.parse(await readFile(path.join(this.root, "contracts", "out", `${name}.sol`, `${name}.json`), "utf8"));
  }
  async checkChain() { if (await retryDeploymentRead(()=>this.client.getChainId()) !== 84532) throw new StudioError("RPC is not Base Sepolia. No transactions sent."); }
  async confirmedBlock() {
    for(let attempt=0;attempt<4;attempt++) {
      const block=await retryDeploymentRead(()=>this.client.getBlock({blockTag:"latest"}));
      if(block.number>=this.lastReceiptBlock)return block;
      if(attempt<3)await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new StudioError("The RPC has not caught up with the previous confirmed setup transaction. Wait a few seconds and resume this profile; no dependent transaction was sent.");
  }
  private async confirmedReceipt(hash:Hex) {
    // Automining local rehearsals produce a block only when another transaction is
    // sent. Public Sepolia can wait for an extra block without that deadlock.
    const confirmations=new URL(this.rpcUrl).hostname==="127.0.0.1"?1:2;
    const receipt=await retryDeploymentRead(()=>this.client.waitForTransactionReceipt({hash,confirmations,timeout:60000}));
    if(receipt.status==="success" && receipt.blockNumber>this.lastReceiptBlock)this.lastReceiptBlock=receipt.blockNumber;
    return receipt;
  }
  async send(name: string, data: Hex, to?: Address, value = 0n) {
    this.phase = name; await this.checkChain();
    const digest = keccak256(toHex(`${to ?? "create"}:${value}:${data}`));
    const old = (await this.journal.read())[name];
    if (old) {
      if (old.digest !== digest) throw new StudioError("Deployment inputs changed. Use a fresh Sepolia profile.");
      const receipt = await this.confirmedReceipt(old.hash);
      if (receipt.status !== "success") throw new StudioError(`Deployment step ${name} reverted; create a fresh deployment.`);
      return { hash: old.hash, address: old.address };
    }
    const address = (await this.admin.backup()).wallets[0].address;
    const account = await this.admin.getAccount(address);
    const wallet = createWalletClient({ chain: baseSepolia, transport: http(this.rpcUrl), account });
    const nonce = await retryDeploymentRead(()=>this.client.getTransactionCount({ address, blockTag: "pending" }));
    const latest = await this.confirmedBlock();
    const gas = await retryDeploymentRead(()=>this.client.estimateGas({ account, to, data, value, blockNumber:latest.number }));
    // Bound RPC-suggested tips as well as total spend. Some nodes suggest a 1 gwei
    // tip even on Base's low-fee test network. Base fee remains RPC-derived.
    const suggestedTip = await retryDeploymentRead(()=>this.client.estimateMaxPriorityFeePerGas());
    const maxPriorityFeePerGas = suggestedTip > 10_000_000n ? 10_000_000n : suggestedTip;
    if (latest.baseFeePerGas === null) throw new StudioError("Sepolia RPC did not provide a base fee.");
    const maxFeePerGas = latest.baseFeePerGas * 2n + maxPriorityFeePerGas;
    const request = await retryDeploymentRead(()=>wallet.prepareTransactionRequest({ to, data, value, gas: gas * 125n / 100n, nonce, maxPriorityFeePerGas, maxFeePerGas }));
    if ((request.maxFeePerGas ?? request.gasPrice ?? 0n) * request.gas > 5000000000000000n)
      throw new StudioError(`This setup transaction exceeds the 0.005 Sepolia ETH gas budget (gas ${request.gas}, max fee ${request.maxFeePerGas ?? request.gasPrice} wei). Wait for lower fees before resuming.`);
    const raw = await wallet.signTransaction(request);
    const hash = keccak256(raw);
    const contract = to ? undefined : getContractAddress({ from: address, nonce: BigInt(nonce) });
    // Persist identity BEFORE submission. An unknown result is never sent again.
    await this.journal.update(rows => ({ ...rows, [name]: { digest, hash, address: contract, confirmed: false } }));
    const actual = await this.client.sendRawTransaction({ serializedTransaction: raw });
    if (actual !== hash) throw new StudioError("RPC returned an unexpected transaction identity.");
    const receipt = await this.confirmedReceipt(hash);
    if (receipt.status !== "success") throw new StudioError(`Deployment step ${name} reverted.`);
    await this.journal.update(rows => ({ ...rows, [name]: { digest, hash, address: contract, confirmed: true } }));
    return { hash, address: contract };
  }
  async deploy(name: string, args: readonly unknown[] = []) {
    this.phase = `Deploy ${name}`;
    const artifact = await this.artifact(name);
    return (await this.send(`Deploy ${name}`, encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }))).address!;
  }
  async call(contract: string, address: Address, method: string, args: readonly unknown[] = [], label = method) {
    this.phase = `${contract}: ${label}`;
    return this.send(`${contract}: ${label}`, encodeFunctionData({ abi: (await this.artifact(contract)).abi, functionName: method, args }), address);
  }
  async deployProtocol(): Promise<Deployment> {
    this.phase = "Verify deployment infrastructure";
    await this.checkChain();
    const coreCode = await retryDeploymentRead(()=>this.client.getCode({ address: SEPOLIA_CORE }));
    if (!coreCode || coreCode === "0x") throw new StudioError("Official Sepolia v4 PoolManager is missing.");
    const corePin = new JsonStore<string | null>(path.join(this.directory,"v4-codehash.json"),null);
    const pin = await corePin.read();
    if (pin && pin !== keccak256(coreCode)) throw new StudioError("Sepolia v4 PoolManager bytecode changed.");
    if (!pin) await corePin.write(keccak256(coreCode));
    await verifyPaymentInfrastructure(this);
    const owner = (await this.admin.backup()).wallets[0].address;
    const quoteToken = await this.deploy("MockCbBTC", [owner]);
    const token = await this.deploy("BitcoinTimeCapsuleToken", [owner]);
    const tombstoneVault = await this.deploy("TombstoneVault", [token]);
    const epochVault = await this.deploy("EpochVault", [token,quoteToken,tombstoneVault,owner]);
    const poolManager = await this.deploy("BitcoinV4Adapter", [SEPOLIA_CORE,token,quoteToken,epochVault,tombstoneVault,owner]);
    const factory = await this.deploy("BitcoinV4HookFactory");
    const hook = await this.artifact("BitcoinV4Hook");
    const initHash = keccak256(encodeDeployData({ abi: hook.abi, bytecode: hook.bytecode.object, args: [SEPOLIA_CORE,poolManager,token,quoteToken,epochVault,tombstoneVault] }));
    let backingHook: Address | undefined;
    for (let i = 0; i < 1000000; i++) {
      const salt = toHex(i, { size: 32 });
      const candidate = getContractAddress({ from: factory, opcode: "CREATE2", salt, bytecodeHash: initHash });
      if ((BigInt(candidate) & 16383n) !== 0x20c8n) continue;
      await this.call("BitcoinV4HookFactory",factory,"deploy",[salt,SEPOLIA_CORE,poolManager,token,quoteToken,epochVault,tombstoneVault]);
      backingHook = candidate; break;
    }
    if (!backingHook) throw new StudioError("Hook address search exhausted.");
    const feeConverter = await this.deploy("FeeConverter", [quoteToken,epochVault,owner]);
    const genesisNFT = await this.deploy("MockGenesis721", ["http://127.0.0.1:3001/api/genesis/"]);
    const rigNFT = await this.deploy("MinerNFT", ["BTC Miners","BTCM",10000n,owner,feeConverter,owner,"ipfs://SEPOLIA_PLACEHOLDER/","ipfs://SEPOLIA_REVEALED/",keccak256(toHex("BTC69K Sepolia test metadata"))]);
    const launchOverride = await this.deploy("LaunchOverrideController", [owner]);
    const launchCurve = await this.deploy("BondingCurve", [token,quoteToken,tombstoneVault,epochVault,poolManager,backingHook,6250000n,25000000n,150,3450000000000n,owner]);
    await this.call("BitcoinV4Adapter",poolManager,"configure",[launchCurve,backingHook]);
    const paymentUSDC = await this.deploy("MockUSDC",[owner]);
    const purchaseRouter = await this.deploy("BTC69KPurchaseRouter",[launchCurve,paymentInfrastructure.weth,paymentUSDC,paymentInfrastructure.swapRouter,paymentInfrastructure.quoter]);
    await this.call("BondingCurve",launchCurve,"configurePurchaseRouter",[purchaseRouter]);
    await seedPaymentLiquidity(this,quoteToken,paymentUSDC,owner);
    const rewardVault = await this.deploy("RewardVault", [token,genesisNFT,rigNFT,epochVault,launchCurve,launchOverride,owner,owner]);
    const rigAuctionHouse = await this.deploy("MinerAuctionHouse", [rigNFT,rewardVault,launchOverride,owner,100000000000000n,owner]);
    const rigMarketplace = await this.deploy("MinerMarketplace", [rigNFT,feeConverter]);
    await this.call("MinerNFT",rigNFT,"setMinter",[rigAuctionHouse,true]);
    await this.call("BitcoinTimeCapsuleToken",token,"initializeSupply",[launchCurve,rewardVault]);
    await this.call("BondingCurve",launchCurve,"initializeInventory");
    await this.call("EpochVault",epochVault,"configure",[rewardVault,launchCurve]);
    for (const [name,address] of [["BitcoinTimeCapsuleToken",token],["MinerNFT",rigNFT],["EpochVault",epochVault]] as const) await this.call(name,address,"renounceOwnership");
    return { purchaseRouter,paymentUSDC,paymentWETH:paymentInfrastructure.weth,paymentUSDCIsMock:true,chainId:84532,quoteIsMock:true,genesisIsMock:true,launchBtcHeight:0,deployer:owner,teamSafe:owner,rootPublisher:owner,quoteToken,token,tombstoneVault,epochVault,poolManager,graduationManager:poolManager,uniswapV4PoolManager:SEPOLIA_CORE,backingHook,feeConverter,genesisNFT,rigNFT,launchOverride,launchCurve,rewardVault,rigAuctionHouse,rigMarketplace };
  }
}
