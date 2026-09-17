import path from "node:path";
import { access, mkdir, realpath } from "node:fs/promises";
import { JsonStore } from "../database/JsonStore.js";
import { StudioError } from "../studio/service.js";

function profileName(name: string) {
  if (typeof name!=="string" || !/^[a-zA-Z0-9_-]{1,50}$/.test(name)) throw new StudioError("Use a simple Sepolia profile name.");
  return name;
}
async function exists(file: string) {
  try { await access(file); return true; } catch(e) { if((e as NodeJS.ErrnoException).code==="ENOENT")return false; throw e; }
}
/** Persist a reference to the original vaults. Never copy or replace keys. */
export async function resolveSepoliaProfiles(root: string, profile: string, requestedWalletProfile?: string) {
  const base=path.resolve(root,".local","base-sepolia");
  const directory=path.join(base,profileName(profile));
  await mkdir(directory,{recursive:true,mode:0o700});
  const baseReal=await realpath(base);
  async function checked(directory: string) {
    const actual=await realpath(directory);
    if(path.dirname(actual).toLowerCase()!==baseReal.toLowerCase())throw new StudioError("Profile must remain inside the Sepolia profile directory.");
    return actual;
  }
  await checked(directory);
  const store=new JsonStore<{walletProfile:string}|null>(path.join(directory,"wallet-profile.json"),null);
  const saved=await store.read();
  if(saved)profileName(saved.walletProfile);
  if(saved && requestedWalletProfile && saved.walletProfile!==requestedWalletProfile)throw new StudioError("This deployment already uses a different wallet profile. Keep its original wallet binding.");
  const walletProfile=profileName(saved?.walletProfile??requestedWalletProfile??profile);
  const walletDirectory=path.join(base,walletProfile);
  if(walletProfile!==profile) {
    if(!saved && (await Promise.all(["wallets/vault.json","admin/vault.json","deployment.json","deployment-transactions.json","settings.json"].map(f=>exists(path.join(directory,f))))).some(Boolean))throw new StudioError("This profile already contains accounts or deployment state. Choose a fresh deployment profile.");
    if(!await exists(walletDirectory))throw new StudioError("The existing wallet profile was not found.");
    await checked(walletDirectory);
    if(!(await Promise.all(["wallets/vault.json","admin/vault.json","settings.json"].map(f=>exists(path.join(walletDirectory,f))))).every(Boolean))throw new StudioError("The source profile needs its original trading vault, deployment vault and website-wallet settings. No new wallets were created.");
  }
  if(!saved)await store.update(current=>{
    if(current && current.walletProfile!==walletProfile)throw new StudioError("Wallet profile changed during startup.");
    return current??{walletProfile};
  });
  return {directory,walletDirectory,walletProfile};
}
