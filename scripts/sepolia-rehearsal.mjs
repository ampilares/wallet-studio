import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { studioRoot as root, bitcoinRoot, foundryBinary } from "./project-paths.mjs";
import { SepoliaService } from "../dist/sepolia/service.js";
execFileSync(foundryBinary("forge"),["build","--root",path.join(bitcoinRoot,"contracts"),"--quiet"],{windowsHide:true,stdio:"inherit"});
const directory=path.join(root,".local","sepolia-rehearsal",randomUUID());
await mkdir(directory,{recursive:true});
const rpcUrl="http://127.0.0.1:18548";
const node=spawn(foundryBinary("anvil"),["--host","127.0.0.1","--port","18548","--chain-id","84532","--fork-url",process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org","--gas-limit","60000000","--gas-price","1000000","--base-fee","1","--silent"],{windowsHide:true,stdio:"ignore"});
async function rpc(method,params=[]){const r=await fetch(rpcUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});const v=await r.json();if(v.error)throw Error(v.error.message);return v.result;}
let service;
try {
  let ready=false;for(let i=0;i<60;i++){try{await rpc("eth_chainId");ready=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}}
  assert.ok(ready,"Fork node unavailable");
  assert.match(await rpc("web3_clientVersion"),/anvil/i);
  await rpc("anvil_setNextBlockBaseFeePerGas",["0x1"]);
  await rpc("evm_mine");
  const secret=randomBytes(32).toString("hex");
  service=new SepoliaService(bitcoinRoot,directory,rpcUrl);
  const browserWallet="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  await service.setup(secret,browserWallet);
  const admin=(await service.admin.backup()).wallets[0].address;
  await rpc("anvil_setBalance",[admin,"0x8ac7230489e80000"]);
  await service.deployAndFund();
  console.log("PASS: real v3/v4 fork deployment, seeded conversion pools, funding, guard configuration");
  const before=await service.curve.state();
  const routedReceipts=[];
  async function mixedPayments(stage) {
    for(const [i,w] of before.wallets.entries()) {
      const payment=["ETH","WETH","USDC"][i%3];
      const amount=payment==="USDC"?"0.1":"0.0000005";
      const old=await service.curve.read(service.curve.deployment.token,"balanceOf",[w.address]);
      const review=await service.curve.preview({operation:"buy",amount,payment,wallets:[w.address],tight:false});
      const result=await service.curve.execute(review.id);
      assert.equal(result.actions[0].status,"CONFIRMED",`${stage} ${payment}: ${result.actions[0].error||""}`);
      assert.ok(await service.curve.read(service.curve.deployment.token,"balanceOf",[w.address])>old);
      routedReceipts.push({stage,payment,wallet:w.address,hash:result.actions[0].txHash});
    }
    console.log(`PASS: all ten wallets buy with mixed ETH/WETH/test USDC through real v3 into ${stage}`);
  }
  await mixedPayments("curve");
  const batches=await service.curve.buyToCap();
  assert.ok(batches.length>0);
  const state=await service.curve.state();
  assert.equal(state.wallets.length,10);
  assert.ok(state.wallets.every(w=>Number(w.guardPurchased)>34499 && Number(w.guardPurchased)<=34500));
  console.log("PASS: all ten wallets buy to their guarded caps after routed purchases");
  const d=service.curve.deployment;
  const block=BigInt(await rpc("eth_blockNumber"));
  const end=await service.curve.read(d.launchCurve,"guardEndBlock");
  if(block<end)await rpc("anvil_mine",[`0x${(end-block).toString(16)}`]);
  const wallets=state.wallets.map(w=>w.address);
  await service.curve.execute((await service.curve.preview({operation:"buy",amount:"0.1",wallets,tight:false})).id);
  assert.equal(await service.curve.read(d.launchCurve,"canGraduate"),true);
  await service.curve.execute((await service.curve.preview({operation:"graduate",amount:"0",wallets:[wallets[0]],tight:false})).id);
  assert.equal(await service.curve.read(d.launchCurve,"graduated"),true);
  const amm=await service.curve.execute((await service.curve.preview({operation:"buy",amount:"0.001",wallets:[wallets[0]],tight:false})).id);
  assert.equal(amm.actions[0].status,"CONFIRMED");
  console.log("PASS: graduation and real Uniswap v4 swap");
  await mixedPayments("v4");
  await writeFile(path.join(directory,"payment-evidence.json"),JSON.stringify({network:"local Base Sepolia fork",passed:true,routedReceipts},null,2));
  console.log(`Rehearsal evidence: ${directory}`);
} catch(e) { console.error(`FAIL ${service?.deployer.phase}: ${e.shortMessage || e.message}`); process.exitCode=1; } finally {service?.studio.lock();service?.admin.lock();if(node.pid)try{execFileSync("taskkill.exe",["/PID",String(node.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});}catch{}}
