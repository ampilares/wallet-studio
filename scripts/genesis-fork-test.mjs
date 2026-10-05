// Read-only access to Base; ALL signatures, funding, and sends stay on a new
// loopback-only Anvil fork with chain ID 31337 and a disposable vault.
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { createPublicClient, http, parseEther, toHex } from "viem";
import { StudioService } from "../dist/studio/service.js";
import { GENESIS, genesisInput, collectionAbi } from "../dist/nft/genesis.js";

const portServer = createServer();
portServer.listen(0, "127.0.0.1");
await once(portServer, "listening");
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const directory = await mkdtemp(path.join(tmpdir(), "wallet-studio-genesis-fork-"));
const rpcUrl = `http://127.0.0.1:${port}`;
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }), pollingInterval: 500 });
const upstream = process.env.STUDIO_BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
const remote = createPublicClient({ transport: http(upstream, { timeout: 30_000, retryCount: 0 }) });
let node;
let studio;
try {
  assert.equal(await remote.getChainId(), 8453, "Fork source must be Base mainnet");
  const block = await remote.getBlockNumber();
  console.log(`Forking Base block ${block}; no mainnet writes.`);
  node = spawn(path.join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil"), ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--accounts", "0", "--fork-url", upstream, "--fork-block-number", String(block), "--silent"], { windowsHide: true, stdio: "ignore" });
  let failed = false;
  node.on("error", () => { failed = true; });
  node.on("exit", () => { failed = true; });
  let ready = false;
  for (let attempt = 0; attempt < 120 && !failed; attempt++) {
    try { ready = await client.getChainId() === 31337; if (ready) break; } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, "Local Anvil fork did not become ready");
  studio = new StudioService(directory, rpcUrl);
  await studio.setup("disposable genesis fork fixture only", 10);
  const wallets = (await studio.metadata()).wallets.slice(0, 2).map(wallet => wallet.address);
  for (const address of wallets) await client.request({ method: "anvil_setBalance", params: [address, toHex(parseEther("0.1"))] });
  const initial = await studio.nft.genesisStatus("local");
  assert.equal(initial.matches, true, "Live collection no longer matches pinned preset");
  if (initial.blockTime < GENESIS.startTime) {
    await client.request({ method: "evm_setNextBlockTimestamp", params: [GENESIS.startTime + 5] });
    await client.request({ method: "evm_mine", params: [] });
  }
  await client.request({ method: "evm_setIntervalMining", params: [1] });
  const draft = await studio.nft.create({ ...genesisInput(wallets, "local"), maxFeePerWalletWei: parseEther("0.001").toString(), spendCeilingWei: parseEther("0.002").toString() });
  const review = await studio.nft.preflight(draft.id);
  assert.equal(review.status, "reviewed", `Fork preflight failed: ${review.jobs.map(job => `${job.status}: ${job.reason}`).join("; ")}`);
  console.log("PASS: live configuration, router simulation, per-wallet eligibility, balances and budget review.");
  await studio.nft.start(draft.id);
  let result;
  for (let attempt = 0; attempt < 240; attempt++) {
    result = await studio.nft.get(draft.id);
    if (result.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(result.status, "completed", `Fork execution ended ${result.status}: ${result.jobs.map(job => `${job.status}: ${job.reason}`).join("; ")}`);
  assert.equal(result.reservedWei, "0");
  for (const job of result.jobs) {
    assert.equal(job.status, "confirmed");
    assert.equal(job.attempts.length, 1);
    assert.equal(job.tokenIds.length, 1);
    assert.equal((await client.readContract({ address: GENESIS.collection, abi: collectionAbi, functionName: "ownerOf", args: [BigInt(job.tokenIds[0])] })).toLowerCase(), job.wallet.toLowerCase());
    assert.equal(await client.getTransactionCount({ address: job.wallet }), 1);
  }
  await studio.nft.reconcile(draft.id);
  assert.equal((await studio.nft.get(draft.id)).spentWei, result.spentWei);
  const second = await studio.nft.create(genesisInput(wallets, "local"));
  const blocked = await studio.nft.preflight(second.id);
  assert.equal(blocked.status, "draft");
  assert.ok(blocked.jobs.every(job => job.status !== "ready"));
  console.log("PASS: two real collection mints on local fork, ownership, confirmation depth, one nonce each, idempotent settlement, duplicate-campaign prevention.");
  console.log("No mainnet transaction was signed or broadcast. Fork gas costs are not a mainnet fee quote.");
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : "Fork validation failed at the RPC/node layer. Check the dedicated Base provider; credentials are intentionally omitted.");
  process.exitCode = 1;
} finally {
  studio?.lock();
  if (node && node.exitCode === null) { const closed = once(node, "exit").catch(() => undefined); node.kill(); await closed; }
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith("wallet-studio-genesis-fork-"));
  await rm(directory, { recursive: true, force: true });
}
