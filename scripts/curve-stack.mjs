import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { studioRoot as root, bitcoinRoot, foundryBinary } from "./project-paths.mjs";
import { createServer } from "node:net";
import { StudioService } from "../dist/studio/service.js";
import { CurveService } from "../dist/curve/service.js";
import { runCurveChecks } from "../dist/curve/checks.js";
import { createStudioServer } from "../dist/studio/server.js";
import { hardenSensitiveFiles } from "./harden-sensitive-files.mjs";

hardenSensitiveFiles(root, process.env.DATA_DIR || "data/base-mainnet");

const testing = process.argv.includes("--test");
const rpcPort = testing ? 18547 : 8546;
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const fixture = randomUUID();
const directory = path.join(root,".local","curve-test",fixture);
const children = [];
let server, timer;
const browserWallet = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const deployer = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
async function free(port) {
  await new Promise((resolve,reject)=>{const probe=createServer();probe.once("error",()=>reject(new Error(`Port ${port} is already occupied. Stop its owner or the old curve stack first.`)));probe.listen(port,"127.0.0.1",()=>probe.close(resolve));});
}
const binary = foundryBinary;
function child(command,args,env,name,cwd=root) {
  const out=openSync(path.join(directory,`${name}.log`),"a");
  const processChild=spawn(command,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:["ignore",out,out]});
  closeSync(out); children.push(processChild);
  processChild.on("error",e=>console.error(`${name}: ${e.message}`));
  return processChild;
}
async function finished(proc,name) {
  const code=await new Promise((resolve,reject)=>{proc.once("exit",resolve);proc.once("error",reject);});
  if(code!==0) { console.error((await readFile(path.join(directory,`${name}.log`),"utf8")).slice(-7000)); throw new Error(`${name} failed; see ${directory}`); }
}
async function waitRpc() {
  for(let i=0;i<100;i++) {
    try { const response=await fetch(rpcUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]}),signal:AbortSignal.timeout(500)});if((await response.json()).result==="0x7a69")return; }catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error("Anvil did not become ready");
}
function stop() {
  clearInterval(timer); server?.close();
  for(const proc of [...children].reverse()) {
    if(proc.exitCode !== null || !proc.pid) continue;
    try { if(process.platform === "win32")execFileSync("taskkill.exe",["/PID",String(proc.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else proc.kill("SIGTERM"); }catch{}
  }
}
process.once("SIGINT",()=>{stop();process.exit(0);});process.once("SIGTERM",()=>{stop();process.exit(0);});
try {
  await free(rpcPort);if(!testing){await free(3001);await free(4312);}
  await mkdir(directory,{recursive:true,mode:0o700});
  if(process.platform === "win32") {
    const identity=execFileSync("whoami.exe",[],{encoding:"utf8",windowsHide:true}).trim();
    execFileSync("icacls.exe",[directory,"/inheritance:r","/grant:r",`${identity}:(OI)(CI)F`,"*S-1-5-18:(OI)(CI)F","*S-1-5-32-544:(OI)(CI)F"],{windowsHide:true,stdio:"ignore"});
  }
  console.log(`Starting isolated curve fixture ${fixture}`);
  child(binary("anvil"),["--host","127.0.0.1","--port",String(rpcPort),"--chain-id","31337","--gas-limit","60000000","--silent"],{},"anvil");
  await waitRpc();
  const deploymentRelative=`deployments/curve-test-${fixture}.json`;
  console.log("Deploying the local bonding curve and mock AMM…");
  await finished(child(binary("forge"),["script","script/DeployLocal.s.sol:DeployLocal","--rpc-url",rpcUrl,"--broadcast","--unlocked","--sender",deployer],{
    LOCAL_DEPLOYER:deployer,LOCAL_TEAM_SAFE:deployer,LOCAL_ROOT_PUBLISHER:"0x70997970C51812dc3A010C7d01b50e0d17dc79C8",LOCAL_DEPLOYMENT_OUTPUT:deploymentRelative,LOCAL_GUARD_BLOCKS:"150",LOCAL_GUARD_CAP:"3450000000000"
  },"deploy",path.join(bitcoinRoot,"contracts")),"deploy");
  const manifest=JSON.parse(await readFile(path.join(bitcoinRoot,"contracts",deploymentRelative),"utf8"));
  await copyFile(path.join(bitcoinRoot,"contracts",deploymentRelative),path.join(directory,"deployment.json"));
  const secret=randomBytes(32).toString("hex");
  const studio=new StudioService(path.join(directory,"vault"),rpcUrl);
  await studio.setup(secret);
  // This disposable, local-only fixture remains usable until its process stops.
  timer=setInterval(()=>void studio.unlock(secret),600000);timer.unref();
  const curve=new CurveService(studio,manifest,directory,rpcUrl,browserWallet);
  await curve.initialize();
  curve.setTestRunner(()=>runCurveChecks(curve));
  if(testing) {
    try { await runCurveChecks(curve); } finally { studio.lock();stop(); }
  } else {
    await curve.prepare();
    if (process.argv.includes("--cap")) await curve.buyToCap();
    const launchToken=randomBytes(32).toString("hex");
    const studioUrl=`http://127.0.0.1:4312/curve#token=${launchToken}`;
    const nextEnv={
      CURVE_TEST_PROFILE:"true",NEXT_PUBLIC_PURCHASE_ROUTER_ADDRESS:"0x0000000000000000000000000000000000000000",NEXT_PUBLIC_LOCAL_MODE:"true",NEXT_PUBLIC_CHAIN_ID:"31337",NEXT_PUBLIC_CHAIN_NAME:"BTC69K Local Test",NEXT_PUBLIC_RPC_URL:rpcUrl,NEXT_PUBLIC_CHAIN_EXPLORER_URL:"",
      NEXT_PUBLIC_LOCAL_WALLET_ADDRESS:browserWallet,NEXT_PUBLIC_CURVE_TEST_STUDIO_URL:studioUrl,
      NEXT_PUBLIC_GENESIS_FREE_MINT_ADDRESS:"0x0000000000000000000000000000000000000000",NEXT_PUBLIC_PRE_REVEAL_MINT_ADDRESS:"0x0000000000000000000000000000000000000000",NEXT_PUBLIC_GENESIS_MARKETPLACE_ADDRESS:"0x0000000000000000000000000000000000000000",
      DATABASE_URL:`pglite:${path.join(directory,"forum-db").replaceAll("\\","/")}`,SESSION_SECRET:randomBytes(32).toString("hex"),IP_HASH_SALT:randomBytes(32).toString("hex"),FORUM_RPC_URL:rpcUrl,FORUM_CHAIN_ID:"31337",FORUM_ADMIN_ADDRESS:browserWallet,
    };
    const fields={TOKEN:"token",CBBTC:"quoteToken",LAUNCH_CURVE:"launchCurve",POOL_MANAGER:"poolManager",RIG_NFT:"rigNFT",GENESIS_NFT:"genesisNFT",LAUNCH_OVERRIDE:"launchOverride",AUCTION_HOUSE:"rigAuctionHouse",MARKETPLACE:"rigMarketplace",REWARD_VAULT:"rewardVault",EPOCH_VAULT:"epochVault",TOMBSTONE:"tombstoneVault"};
    for(const [name,key] of Object.entries(fields)) nextEnv[`NEXT_PUBLIC_${name}_ADDRESS`]=manifest[key];
    console.log("Preparing the isolated website database…");
    await finished(child(process.execPath,["--import","tsx","src/db/migrate.ts"],nextEnv,"database",path.join(bitcoinRoot,"web")),"database");
    const result=createStudioServer(studio,path.join(root,"dist","studio","public"),4312,launchToken,curve);
    server=result.server;server.listen(4312,"127.0.0.1");
    child(process.execPath,[path.join(bitcoinRoot,"node_modules","next","dist","bin","next"),"dev","web","--hostname","127.0.0.1","--port","3001"],nextEnv,"website",bitcoinRoot);
    const runtime={pid:process.pid,fixture,directory,rpcUrl,website:"http://127.0.0.1:3001/launchpad",studioUrl,children:children.filter(p=>p.exitCode===null).map(p=>p.pid)};
    await writeFile(path.join(root,".local","curve-test","runtime.json"),JSON.stringify(runtime,null,2),{mode:0o600});
    console.log(`\nBTC69K Launchpad: ${runtime.website}\nWallet Studio: ${studioUrl}\nPrefunded website wallet: ${browserWallet}\nReports/logs: ${directory}\nStop: npm run local:curve:down\n`);
  }
} catch(e) { console.error(e);stop();process.exitCode=1; }
