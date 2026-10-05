import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { StudioService } from "./service.js";
import { createStudioServer } from "./server.js";
import { JsonStore } from "../database/JsonStore.js";
import type { MintCampaign } from "../nft/types.js";
import type { Activity } from "./types.js";

const passphrase = "studio QA fixture - no real funds";
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function temporary() {
  const dir = await mkdtemp(path.join(tmpdir(), "wallet-studio-test-"));
  return { dir, async cleanup() {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith("wallet-studio-test-"));
    await rm(dir, { recursive: true, force: true });
  } };
}

test("vault encryption, locking, persistence and localhost API boundaries", async () => {
  const temp = await temporary();
  const service = new StudioService(temp.dir);
  const port = await freePort();
  const { server, launchUrl } = createStudioServer(service, "missing-assets", port);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const origin = new URL(launchUrl).origin;
  let cookie = "";
  const request = (route: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${origin}/api/${route}`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Studio-Request": "1", Cookie: cookie, ...extra }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await request("setup", { passphrase })).status, 401);
    assert.equal((await request("session", { token: "wrong" })).status, 401);
    assert.equal((await request("session", { token: "é".repeat(64) })).status, 401);
    const session = await request("session", { token: new URL(launchUrl).hash.slice(7) });
    assert.equal(session.status, 200);
    assert.match(session.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    cookie = session.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await request("setup", { passphrase }, { Origin: "https://attacker.example" })).status, 403);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${origin}/api/setup`, { method: "POST", headers: { Host: "attacker.example" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(badHostStatus, 403);
    const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(origin, { path: "http://[", headers: { Host: new URL(origin).host } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(malformedStatus, 400);
    assert.equal((await request("setup", { passphrase }, { "X-Studio-Request": "" })).status, 403);
    assert.equal((await request("setup", { passphrase, extra: true })).status, 400);
    assert.equal((await request("setup", { passphrase })).status, 200);
    const vault = await service.backup();
    assert.equal(vault.wallets.length, 10);
    assert.equal(new Set(vault.wallets.map(w => w.address)).size, 10);
    const disk = await readFile(path.join(temp.dir, "vault.json"), "utf8");
    assert.ok(!disk.includes(passphrase));
    assert.ok(vault.wallets.every(w => w.encryptedPrivateKey && w.salt && w.iv));
    await assert.rejects(service.setup(passphrase), /already exists/);
    await assert.rejects(service.preview({ network: "mainnet", kind: "send", from: "", to: "", wallets: [], amount: "1" }), /read-only/);
    assert.equal((await request("test-funds", { network: "mainnet", wallets: [vault.wallets[0].address] })).status, 400);
    await service.rename(vault.wallets[0].address, "Treasury");
    service.lock();
    await assert.rejects(service.backup(), /Unlock/);
    await assert.rejects(service.addWallets(1), /Unlock/);
    await assert.rejects(service.fundLocal([vault.wallets[0].address]), /Unlock/);
    const restored = new StudioService(temp.dir);
    await assert.rejects(restored.unlock("incorrect passphrase"), /did not unlock/);
    await restored.unlock(passphrase);
    assert.equal((await restored.backup()).wallets[0].label, "Treasury");
    for (let i = 0; i < 5; i++) assert.equal((await request("unlock", { passphrase: "wrong" })).status, 400);
    assert.equal((await request("unlock", { passphrase })).status, 429);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await temp.cleanup();
  }
});

const anvilPath = path.join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
test("Sepolia setup cannot bypass the shared vault unlock attempt limit", async () => {
  const temp = await temporary();
  const port = await freePort();
  let attempts = 0;
  const service = new StudioService(temp.dir);
  const { server, launchUrl } = createStudioServer(service, "missing-assets", port, undefined, undefined, async () => {
    attempts++; throw new Error("incorrect passphrase");
  });
  server.listen(port, "127.0.0.1"); await once(server, "listening");
  const origin = new URL(launchUrl).origin;
  let cookie = "";
  const request = (route: string, body: unknown) => fetch(`${origin}/api/${route}`, { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json", "X-Studio-Request": "1", Cookie: cookie,
  }, body: JSON.stringify(body) });
  try {
    const response = await request("session", { token: new URL(launchUrl).hash.slice(7) });
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    await response.arrayBuffer();
    for (let i = 0; i < 5; i++) { const result = await request("sepolia/setup", { passphrase: "incorrect" }); assert.equal(result.status, 400); await result.arrayBuffer(); }
    for (const route of ["sepolia/setup", "unlock"]) { const result = await request(route, { passphrase }); assert.equal(result.status, 429); await result.arrayBuffer(); }
    assert.equal(attempts, 5);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await temp.cleanup();
  }
});

test("real local EVM: fund ten wallets, review, send, distribute, collect and prevent repeats", { skip: !existsSync(anvilPath) && "Foundry Anvil is required for local EVM integration", timeout: 90_000 }, async t => {
  const temp = await temporary();
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const node = spawn(anvilPath, ["--host", "127.0.0.1", "--port", String(port), "--accounts", "0", "--silent"], { windowsHide: true, stdio: "ignore" });
  const exited = once(node, "exit");
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try { ready = (await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })).ok; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, "Anvil started");
    const service = new StudioService(temp.dir, rpc);
    await service.setup(passphrase);
    let state = await service.state("local");
    assert.equal(state.rpcError, null);
    assert.equal(state.network.chainId, 31337);
    assert.equal(state.wallets.length, 10);
    assert.ok(!JSON.stringify(state).includes("encryptedPrivateKey"));
    const addresses = state.wallets.map(w => w.address);
    await service.fundLocal(addresses);
    state = await service.state("local");
    assert.ok(state.wallets.every(w => w.balance === "10"));
    const input = { network: "local" as const, kind: "send" as const, from: addresses[0], to: addresses[1], wallets: [], amount: "0.25" };
    await assert.rejects(service.preview({ ...input, amount: "100" }), /Insufficient/);
    await assert.rejects(service.preview({ ...input, to: "0x" + "0".repeat(40) }), /non-zero/);
    const review = await service.preview(input);
    assert.equal(review.total, "0.25");
    assert.equal((await service.state("local")).wallets[1].balance, "10", "review never broadcasts");
    assert.equal((await service.execute(review.id)).sent, 1);
    await assert.rejects(service.execute(review.id), /already used/);
    state = await service.state("local");
    assert.equal(state.wallets[1].balance, "10.25");
    assert.ok(state.activity.find(a => a.kind === "transfer" && a.status === "confirmed" && a.hash));
    const distribution = await service.preview({ ...input, kind: "distribute", wallets: addresses.slice(1), amount: "0.1" });
    assert.equal(distribution.lines.length, 9);
    assert.equal((await service.execute(distribution.id)).sent, 9);
    const collection = await service.preview({ ...input, kind: "collect", to: addresses[0], wallets: addresses.slice(1), amount: "0.1" });
    assert.equal((await service.execute(collection.id)).sent, 9);
    assert.equal((await service.state("local")).activity.filter(a => a.kind === "transfer" && a.status === "confirmed").length, 19);
    const lockedPlan = await service.preview(input);
    service.lock();
    await service.unlock(passphrase);
    await assert.rejects(service.execute(lockedPlan.id), /expired/);

    const history = new JsonStore<Activity[]>(path.join(temp.dir, "activity.json"), []);
    await t.test("a reviewed transfer is blocked if an NFT submission appears before execution", async () => {
      const review = await service.preview(input);
      const campaigns = new JsonStore<MintCampaign[]>(path.join(temp.dir, "nft-campaigns.json"), []);
      await campaigns.write([{ id: "pending-mint", updatedAt: "", input: { network: "local" }, jobs: [{ wallet: addresses[0], status: "signed", txHash: `0x${"11".repeat(32)}`, attempts: [] }] }] as unknown as MintCampaign[]);
      await assert.rejects(service.execute(review.id), /unresolved NFT/);
      await campaigns.write([]);
    });
    await t.test("execution rechecks transfers recorded after preview", async () => {
      const review = await service.preview(input);
      const rows = await history.read();
      await history.write([...rows, { id: "ambiguous", network: "local", kind: "transfer", from: addresses[0], to: addresses[1], amount: "1", status: "signed", createdAt: "" }]);
      await assert.rejects(service.execute(review.id), /unresolved ETH transfer/);
      await history.write(rows);
    });
    await t.test("mixed-case wallet selection cannot duplicate payments", async () => {
      const review = await service.preview({ ...input, kind: "distribute", wallets: [addresses[1], addresses[1].toLowerCase()] });
      assert.equal(review.lines.length, 1);
    });
    await t.test("old pending transactions reconcile outside the 80-row display window", async () => {
      const rows = await history.read();
      const original = rows.find(row => row.kind === "transfer" && row.hash)!;
      await history.write([{ ...original, id: "old-pending", status: "submitted" }, ...Array.from({ length: 81 }, (_, i) => ({ ...original, id: `display-${i}`, status: "confirmed" as const }))]);
      assert.equal((await service.state("local")).activity.length, 80);
      assert.equal((await history.read())[0].status, "confirmed");
      await history.write(rows);
    });
    await t.test("lock during nonce lookup revokes a reviewed transfer before signing", async () => {
      const review = await service.preview(input);
      const connection = await service.chainConnection("local");
      const lookup = connection.client.getTransactionCount.bind(connection.client);
      t.mock.method(connection.client, "getTransactionCount", async (args: Parameters<typeof lookup>[0]) => { const nonce = await lookup(args); service.lock(); return nonce; });
      const override = t.mock.method(service as unknown as { checkedConnection: StudioService["chainConnection"] }, "checkedConnection", async () => connection);
      const count = (await history.read()).length;
      try { await assert.rejects(service.execute(review.id), /Unlock/); }
      finally { override.mock.restore(); }
      assert.equal((await history.read()).length, count, "no signed record or broadcast");
      await service.unlock(passphrase);
    });
  } finally {
    node.kill();
    await exited;
    await temp.cleanup();
  }
});
