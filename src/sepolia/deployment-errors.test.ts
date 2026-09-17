import test from "node:test";
import assert from "node:assert/strict";
import { retryDeploymentRead, deploymentFailureMessage } from "./deployment-errors.js";
import { SepoliaDeployment } from "./deployment.js";
import { StudioService } from "../studio/service.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { keccak256,toHex } from "viem";

test("unsigned reads retry transient limits and stop after three attempts",async()=>{
  let calls=0;
  assert.equal(await retryDeploymentRead(async()=>{if(++calls<3)throw {cause:{code:-32016,message:"over rate limit"}};return 42;},0),42);
  assert.equal(calls,3);
  calls=0;
  await assert.rejects(retryDeploymentRead(async()=>{calls++;throw Object.assign(new Error("limited"),{status:429});},0));
  assert.equal(calls,3);
  calls=0;
  await assert.rejects(retryDeploymentRead(async()=>{calls++;throw Object.assign(new Error("revert"),{name:"ContractFunctionRevertedError"});},0));
  assert.equal(calls,1);
});
test("deployment diagnostics preserve the stage and hash without leaking provider credentials",()=>{
  const secret="sensitive-test-key";
  const error={cause:{status:401,message:`https://provider.invalid/v2/${secret}`}};
  const text=deploymentFailureMessage("Configure router",error);
  assert.match(text,/Configure router/);assert.match(text,/rejected access/);assert.ok(!text.includes(secret));
  const saved=deploymentFailureMessage("Deploy token",{status:429},"0xabc");
  assert.match(saved,/0xabc/);assert.match(saved,/exact hash/);assert.ok(!saved.includes("No transaction"));
});
test("resuming confirmed journal steps never unlocks a wallet or submits again",async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"btc69k-deploy-resume-"));
  const d=new SepoliaDeployment(dir,dir,"http://127.0.0.1:18548",new StudioService(path.join(dir,"locked-admin")));
  const hash=`0x${"ab".repeat(32)}` as const;
  const address="0x0000000000000000000000000000000000000001";
  await d.journal.write({"Deploy example":{digest:keccak256(toHex("create:0:0x")),hash,address,confirmed:true}});
  d.client.getChainId=async()=>84532;
  let receipts=0;
  d.client.waitForTransactionReceipt=(async(args:{hash:string})=>{assert.equal(args.hash,hash);receipts++;return {status:"success",blockNumber:100n};}) as typeof d.client.waitForTransactionReceipt;
  d.client.sendRawTransaction=async()=>{throw new Error("Must never broadcast");};
  assert.deepEqual(await d.send("Deploy example","0x"),{hash,address});assert.equal(receipts,1);
  let blockReads=0;
  d.client.getBlock=(async()=>({number:++blockReads===1?99n:100n})) as typeof d.client.getBlock;
  assert.equal((await d.confirmedBlock()).number,100n);
  assert.equal(blockReads,2,"Must not estimate using state older than the confirmed dependency");
  await assert.rejects(d.send("Deploy example","0x01"),/inputs changed/);
  assert.equal(receipts,1);
});
