import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { studioRoot as root, bitcoinRoot, foundryBinary } from "./project-paths.mjs";
import path from "node:path";
import { resolveSepoliaProfiles } from "../dist/sepolia/profiles.js";
import { SepoliaService } from "../dist/sepolia/service.js";
import { createStudioServer } from "../dist/studio/server.js";

execFileSync(foundryBinary("forge"),["build","--root",path.join(bitcoinRoot,"contracts"),"--quiet"],{windowsHide:true,stdio:"inherit"});
const profile=process.env.SEPOLIA_PROFILE || "default";
const {directory,walletDirectory,walletProfile}=await resolveSepoliaProfiles(root,profile,process.env.SEPOLIA_WALLET_PROFILE);
const rpcUrl=process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const token=randomBytes(32).toString("hex");
const studioUrl=`http://127.0.0.1:4313/curve?network=sepolia#token=${token}`;
const children=[];
let website;
await mkdir(directory,{recursive:true,mode:0o700});
if(process.platform === "win32") {
  const identity=execFileSync("whoami.exe",[],{encoding:"utf8",windowsHide:true}).trim();
  execFileSync("icacls.exe",[directory,"/inheritance:r","/grant:r",`${identity}:(OI)(CI)F`,"*S-1-5-18:(OI)(CI)F","*S-1-5-32-544:(OI)(CI)F"],{windowsHide:true,stdio:"ignore"});
}
function start(args,env,name,cwd=root) {
  const log=openSync(path.join(directory,`${name}.log`),"a");
  const child=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:["ignore",log,log]});
  closeSync(log);children.push(child);return child;
}
async function runtime() {await writeFile(path.join(root,".local","base-sepolia","runtime.json"),JSON.stringify({pid:process.pid,directory,studioUrl,children:children.filter(c=>c.exitCode===null).map(c=>c.pid)},null,2));}
const service=new SepoliaService(bitcoinRoot,directory,rpcUrl,async(d,browserWallet)=>{
  if(website && website.exitCode===null)return;
  await new Promise((resolve,reject)=>{const probe=createServer();probe.once("error",()=>reject(new Error("Port 3001 is occupied; stop the old local stack first.")));probe.listen(3001,"127.0.0.1",()=>probe.close(resolve));});
  const secretsPath=path.join(directory,"website-secrets.json");
  let secrets;try{secrets=JSON.parse(await readFile(secretsPath,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;secrets={SESSION_SECRET:randomBytes(32).toString("hex"),IP_HASH_SALT:randomBytes(32).toString("hex")};await writeFile(secretsPath,JSON.stringify(secrets),{mode:0o600});}
  const env={...secrets,SEPOLIA_TEST_PROFILE:"true",CURVE_TEST_PROFILE:"false",NEXT_PUBLIC_LOCAL_MODE:"false",NEXT_PUBLIC_CHAIN_ID:"84532",NEXT_PUBLIC_CHAIN_NAME:"Base Sepolia",NEXT_PUBLIC_RPC_URL:"https://sepolia.base.org",NEXT_PUBLIC_CHAIN_EXPLORER_URL:"https://sepolia.basescan.org",NEXT_PUBLIC_CURVE_TEST_STUDIO_URL:studioUrl,NEXT_PUBLIC_LOCAL_WALLET_ADDRESS:"",DATABASE_URL:`pglite:${path.join(directory,"forum-db").replaceAll("\\","/")}`,FORUM_RPC_URL:rpcUrl,FORUM_CHAIN_ID:"84532",FORUM_ADMIN_ADDRESS:browserWallet};
  const fields={PURCHASE_ROUTER:"purchaseRouter",TOKEN:"token",CBBTC:"quoteToken",LAUNCH_CURVE:"launchCurve",POOL_MANAGER:"poolManager",RIG_NFT:"rigNFT",GENESIS_NFT:"genesisNFT",LAUNCH_OVERRIDE:"launchOverride",AUCTION_HOUSE:"rigAuctionHouse",MARKETPLACE:"rigMarketplace",REWARD_VAULT:"rewardVault",EPOCH_VAULT:"epochVault",TOMBSTONE:"tombstoneVault"};
  for(const [name,key] of Object.entries(fields))env[`NEXT_PUBLIC_${name}_ADDRESS`]=d[key] || "0x0000000000000000000000000000000000000000";
  for(const name of ["GENESIS_FREE_MINT","PRE_REVEAL_MINT","GENESIS_MARKETPLACE"])env[`NEXT_PUBLIC_${name}_ADDRESS`]="0x0000000000000000000000000000000000000000";
  const migrate=start(["--import","tsx","src/db/migrate.ts"],env,"database",path.join(bitcoinRoot,"web"));
  await new Promise((resolve,reject)=>{migrate.once("error",reject);migrate.once("exit",code=>code===0?resolve():reject(new Error("Website database migration failed")));});
  website=start([path.join(bitcoinRoot,"node_modules","next","dist","bin","next"),"dev","web","--hostname","127.0.0.1","--port","3001"],env,"website",bitcoinRoot);
  await runtime();
},walletDirectory);
const facade={get busy(){return service.busy || !!service.curve?.busy;},state:()=>service.requireCurve().state(),preview:input=>service.requireCurve().preview(input),start:(action,id)=>{if(service.busy)throw new Error("Setup is busy");return service.requireCurve().start(action,id);}};
const {server}=createStudioServer(service.studio,path.join(root,"dist","studio","public"),4313,token,facade,(route,input)=>service.handle(route,input));
await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(4313,"127.0.0.1",resolve);});
await runtime();
console.log(`Base Sepolia setup: ${studioUrl}\nPersistent deployment profile: ${directory}\nWallet profile: ${walletProfile} (use its existing passphrase)\nThe website starts after deployment. No transactions run until you choose Deploy and fund.\nStop: npm run sepolia:curve:down`);
function stop(){service.studio.lock();service.admin.lock();server.close();for(const child of children)if(child.exitCode===null&&child.pid){try{execFileSync("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});}catch{}}}
process.once("SIGINT",()=>{stop();process.exit(0);});process.once("SIGTERM",()=>{stop();process.exit(0);});
