import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveSepoliaProfiles } from "./profiles.js";
import { SepoliaService } from "./service.js";

test("fresh contracts reuse original encrypted wallets, signer identities and passphrase without copying vaults",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"btc69k-profile-reuse-"));
  const source=await resolveSepoliaProfiles(root,"default");
  const old=new SepoliaService(root,source.directory,"http://127.0.0.1:18548");
  const secret=randomBytes(32).toString("hex");
  const browser="0x0000000000000000000000000000000000000001";
  try {
    await old.setup(secret,browser);
    const marker=path.join(source.directory,"deployment.json");
    await writeFile(marker,'{"oldDeployment":"preserve"}');
    const files=["wallets/vault.json","admin/vault.json","settings.json","deployment.json"];
    const originals=await Promise.all(files.map(f=>readFile(path.join(source.directory,f))));
    const selected=await resolveSepoliaProfiles(root,"payments-v1","default");
    const next=new SepoliaService(root,selected.directory,"http://127.0.0.1:18548",undefined,selected.walletDirectory);
    try {
      assert.equal(next.reusingWallets,true);
      assert.deepEqual(await next.walletSettings(),{browserWallet:browser});
      await assert.rejects(next.setup("incorrect-passphrase-for-test",browser),/did not unlock/);
      assert.equal(next.admin.unlocked,false);assert.equal(next.studio.unlocked,false);
      await assert.rejects(next.setup(secret,"0x0000000000000000000000000000000000000002"),/original website wallet/);
      await next.setup(secret,browser);
      const before=(await old.studio.metadata()).wallets,after=(await next.studio.metadata()).wallets;
      assert.equal(after.length,10);assert.deepEqual(after,before);
      assert.deepEqual((await next.admin.metadata()).wallets,(await old.admin.metadata()).wallets);
      for(const w of after)assert.equal((await next.studio.getAccount(w.address)).address,w.address);
      assert.equal(await next.manifest.read(),null);
      await assert.rejects(access(path.join(selected.directory,"wallets","vault.json")));
      for(const [i,f] of files.entries())assert.deepEqual(await readFile(path.join(source.directory,f)),originals[i]);
      assert.deepEqual(await resolveSepoliaProfiles(root,"payments-v1"),selected);
      await assert.rejects(resolveSepoliaProfiles(root,"payments-v1","another"),/different wallet profile/);
      next.deployer.client.multicall=(async()=>Array(11).fill(3000000000000000n)) as typeof next.deployer.client.multicall;
      assert.equal(await next.fundingBudget(),12000000000000000n);
      next.deployer.client.multicall=(async()=>Array(11).fill(0n)) as typeof next.deployer.client.multicall;
      assert.equal(await next.fundingBudget(),45000000000000000n);
    } finally {next.studio.lock();next.admin.lock();}
  } finally {old.studio.lock();old.admin.lock();}
});

test("wallet reuse rejects missing sources, path traversal and replacing an established deployment",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"btc69k-profile-validation-"));
  await assert.rejects(resolveSepoliaProfiles(root,"../escape"),/simple/);
  await assert.rejects(resolveSepoliaProfiles(root,"new","../escape"),/simple/);
  await assert.rejects(resolveSepoliaProfiles(root,"new","missing"),/not found/);
  const base=path.join(root,".local","base-sepolia");
  await mkdir(path.join(base,"occupied"),{recursive:true});
  await writeFile(path.join(base,"occupied","deployment-transactions.json"),"{}");
  await assert.rejects(resolveSepoliaProfiles(root,"occupied","default"),/already contains/);
  await mkdir(path.join(base,"incomplete"),{recursive:true});
  await assert.rejects(resolveSepoliaProfiles(root,"new","incomplete"),/original trading vault/);
});
