import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createPublicClient, http, parseEther, toHex, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { StudioService } from "./service.js";

const anvilPath = path.join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const password = "disposable mainnet funding test fixture";

test("Base funding: 199 recipients, gates, restart recovery and duplicate prevention on isolated Anvil", { skip: !existsSync(anvilPath) && "Anvil required", timeout: 180_000 }, async t => {
  const previousGate = process.env.MAINNET_SEND_ENABLED;
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const rpc = `http://127.0.0.1:${port}`;
  const node = spawn(anvilPath, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--accounts", "0", "--silent"], { windowsHide: true, stdio: "ignore" });
  const exited = once(node, "exit");
  const directories: string[] = [];
  const raw = createPublicClient({ chain: base, transport: http(rpc, { retryCount: 0, timeout: 1000 }), pollingInterval: 20 });
  const mutate = (method: string, params: unknown[]) => raw.request({ method: method as never, params: params as never });
  const mode = { lostReply: false, hideReceipt: false, sends: 0, pause: undefined as (() => Promise<void>) | undefined };
  const client = {
    ...raw,
    async sendRawTransaction(args: { serializedTransaction: Hex }) {
      mode.sends++;
      const hash = await raw.sendRawTransaction(args);
      await mode.pause?.();
      if (mode.lostReply) throw new Error("Provider URL and credentials must never escape this simulated timeout");
      return hash;
    },
    async waitForTransactionReceipt(args: Parameters<typeof raw.waitForTransactionReceipt>[0]) {
      await mutate("evm_mine", []);
      return raw.waitForTransactionReceipt({ ...args, pollingInterval: 20, timeout: 1500 });
    },
    async getTransactionReceipt(args: Parameters<typeof raw.getTransactionReceipt>[0]) {
      if (mode.hideReceipt) throw new Error("Receipt temporarily unavailable");
      return { ...await raw.getTransactionReceipt(args), l1Fee: 0n };
    },
  };
  const connect: StudioService["chainConnection"] = async () => ({ chain: base, client, transport: http(rpc) }) as unknown as Awaited<ReturnType<StudioService["chainConnection"]>>;
  async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "studio-funding-test-")); directories.push(dir);
    const service = new StudioService(dir); service.chainConnection = connect;
    await service.setup(password);
    const wallets = (await service.metadata()).wallets.map(wallet => wallet.address);
    await mutate("anvil_setBalance", [wallets[0], toHex(parseEther("2"))]);
    return { service, dir, wallets, input: { from: wallets[0], wallets: wallets.slice(1, 3), amount: "0.0001", maxFeePerTransfer: "0.001" } };
  }
  async function idle(service: StudioService, id: string) {
    for (let attempt = 0; attempt < 5000; attempt++) {
      const batch = (await service.funding.list()).find(batch => batch.id === id)!;
      if (batch.status !== "running") {
        try { await service.exclusiveOperation(async () => undefined); return batch; } catch { /* Worker draining. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Test funding worker did not finish");
  }
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) { try { ready = await raw.getChainId() === 8453; if (ready) break; } catch { /* Starting. */ } await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(ready);
    // Anvil has no OP Stack predeploys or L1 charges. Stub only the fee oracle;
    // ETH transfers, signatures, nonces, receipts and balances are real local EVM.
    await mutate("anvil_setCode", ["0x420000000000000000000000000000000000000F", "0x600060005260206000f3"]);

    await t.test("200-wallet vault funds 199 recipients exactly once after both approvals", async () => {
      const { service, input } = await fixture();
      try {
        const original = (await service.metadata()).wallets;
        await service.addWallets(190);
        await assert.rejects(service.addWallets(1), /up to 200/);
        assert.deepEqual((await service.metadata()).wallets.slice(0, 10), original);
        const wallets = (await service.metadata()).wallets.map(wallet => wallet.address);
        const review = await service.funding.preview({ ...input, wallets });
        assert.equal(review.lines.length, 199);
        assert.equal(review.totalWei, parseEther("0.0199").toString());
        assert.ok(review.lines.every(line => line.to !== input.from));
        assert.equal(await raw.getBalance({ address: wallets[1] }), 0n);
        process.env.MAINNET_SEND_ENABLED = "false";
        await assert.rejects(service.funding.start(review.id, true), /MAINNET_SEND_ENABLED/);
        process.env.MAINNET_SEND_ENABLED = "true";
        await assert.rejects(service.funding.start(review.id, false), /Approve/);
        const starts = await Promise.allSettled([service.funding.start(review.id, true), service.funding.start(review.id, true)]);
        assert.equal(starts.filter(result => result.status === "fulfilled").length, 1);
        const finished = await idle(service, review.id);
        assert.equal(finished.status, "completed", finished.error);
        assert.ok(finished.lines.every(line => line.status === "confirmed"));
        for (const address of wallets.slice(1)) assert.equal(await raw.getBalance({ address }), parseEther("0.0001"));
        assert.equal(await raw.getTransactionCount({ address: wallets[0] }), 199);
        await assert.rejects(service.funding.start(review.id, true), /already completed/);
        assert.ok(!JSON.stringify(finished).includes("ciphertext"));
        assert.ok(!JSON.stringify(finished).includes("recovery"));
      } finally { service.lock(); }
    });

    await t.test("accepted transfer with lost response survives restart and never repays a confirmed recipient", async () => {
      const { service, dir, input, wallets } = await fixture();
      const initialSends = mode.sends;
      let restored: StudioService | undefined;
      try {
        const review = await service.funding.preview(input);
        mode.lostReply = true; mode.hideReceipt = true;
        await service.funding.start(review.id, true);
        const partial = await idle(service, review.id);
        assert.equal(partial.status, "partial"); assert.equal(partial.lines[0].status, "unresolved");
        assert.equal(partial.lines[1].status, "ready");
        assert.ok(!partial.error?.includes("credentials"));
        await assert.rejects(service.funding.preview(input), /existing partial/);
        await assert.rejects(service.funding.review(review.id), /existing hash/);
        await assert.rejects(service.funding.assertNoPending(input.from as Address), /unresolved funding/);
        restored = new StudioService(dir); restored.chainConnection = connect; await restored.unlock(password);
        assert.equal((await restored.funding.list())[0].lines[0].hash, partial.lines[0].hash);
        mode.lostReply = false; mode.hideReceipt = false;
        await mutate("evm_mine", []);
        await restored.funding.reconcile(review.id);
        await restored.funding.start(review.id, true);
        const completed = await idle(restored, review.id);
        assert.equal(completed.status, "completed", completed.error);
        assert.equal(mode.sends - initialSends, 2);
        for (const address of wallets.slice(1, 3)) assert.equal(await raw.getBalance({ address }), parseEther("0.0001"));
      } finally { mode.lostReply = false; mode.hideReceipt = false; service.lock(); restored?.lock(); }
    });

    await t.test("rejects external wallets, insufficient funds, tiny fee allowance and wrong network", async () => {
      const { service, input } = await fixture();
      try {
        await assert.rejects(service.funding.preview({ ...input, wallets: ["0x1111111111111111111111111111111111111111"] }), /other wallets/);
        await assert.rejects(service.funding.preview({ ...input, amount: "2" }), /enough Base ETH/);
        await assert.rejects(service.funding.preview({ ...input, maxFeePerTransfer: "0.000000000000000001" }), /fee allowance/);
        await assert.rejects(service.funding.preview({ ...input, amount: "-1" }), /positive ETH/);
        service.chainConnection = async () => ({ ...await connect("mainnet"), chain: { ...base, id: 84532 } }) as unknown as Awaited<ReturnType<StudioService["chainConnection"]>>;
        await assert.rejects(service.funding.preview(input), /chain 8453/);
      } finally { service.lock(); }
    });

    await t.test("stop and shared vault lock preserve the unsent remainder for a refreshed review", async () => {
      const { service, input } = await fixture();
      try {
        const review = await service.funding.preview(input);
        mode.pause = async () => { await assert.rejects(service.exclusiveOperation(async () => undefined), /operation/); await service.funding.stop(review.id); };
        await service.funding.start(review.id, true);
        const stopped = await idle(service, review.id);
        assert.equal(stopped.status, "stopped"); assert.equal(stopped.lines[0].status, "confirmed"); assert.equal(stopped.lines[1].status, "ready");
        mode.pause = undefined;
        await service.funding.review(review.id);
        await service.funding.start(review.id, true);
        assert.equal((await idle(service, review.id)).status, "completed");
      } finally { mode.pause = undefined; service.lock(); }
    });
  } finally {
    if (previousGate === undefined) delete process.env.MAINNET_SEND_ENABLED; else process.env.MAINNET_SEND_ENABLED = previousGate;
    node.kill(); await exited;
    for (const dir of directories) { assert.equal(path.dirname(dir), path.resolve(tmpdir())); assert.ok(path.basename(dir).startsWith("studio-funding-test-")); await rm(dir, { recursive: true, force: true }); }
  }
});
