import assert from "node:assert/strict";
import { encodeFunctionData, type Abi, type Address } from "viem";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CurveService } from "./service.js";
import { protocolAbi } from "./abi.js";
import type { CurveView } from "./types.js";

export async function runCurveChecks(service: CurveService) {
  const results: NonNullable<CurveView["report"]> = [];
  const evidence: unknown[] = [];
  const d = service.deployment;
  const record = (name: string, detail: string) => {
    results.push({ name, passed: true, detail }); service.report = [...results];
    console.log(`PASS ${name}: ${detail}`);
  };
  const approve = async (wallets: Address[], amount: bigint) => {
    const bundle = await service.bundle("Guard check approvals", wallets.map(walletAddress => ({ type: "APPROVE" as const, walletAddress, target: d.quoteToken, valueWei: "0", calldata: encodeFunctionData({ abi: protocolAbi, functionName: "approve", args: [d.launchCurve, amount] }) })));
    assert.ok(bundle.actions.every(a => a.status === "CONFIRMED"));
  };
  const buyCall = (wallet: Address, amount: bigint) => service.client.simulateContract({ account: wallet, address: d.launchCurve, abi: protocolAbi as Abi, functionName: "buy", args: [amount, 1n] });
  try {
    await service.reset();
    assert.equal(await service.read<number>(d.launchCurve, "guardBlocks"), 150);
    const cap = 34500n * 100000000n;
    assert.equal(await service.read<bigint>(d.launchCurve, "walletGuardCap"), cap);
    assert.equal(await service.read<bigint>(d.launchCurve, "guardEndBlock"), 0n);
    const wallets = (await service.studio.backup()).wallets.map(w => w.address);
    assert.equal(wallets.length, 10); assert.equal(new Set(wallets).size, 10);
    const batches = await service.buyToCap();
    assert.ok(batches.length >= 4);
    const receipts = [];
    for (const batch of batches) {
      assert.ok(batch.actions.every(a => a.status === "CONFIRMED"));
      const mined = await Promise.all(batch.actions.map(a => service.client.getTransactionReceipt({ hash: a.txHash! })));
      assert.equal(new Set(mined.map(r => String(r.blockNumber))).size, 1);
      receipts.push(...mined);
    }
    const end = await service.read<bigint>(d.launchCurve, "guardEndBlock");
    assert.equal(end, receipts[0].blockNumber + 150n);
    assert.ok(receipts.every(r => r.blockNumber < end));
    const [, smallestOutput] = await service.read<readonly [bigint,bigint,bigint]>(d.launchCurve, "previewBuy", [1n]);
    const rows = [];
    for (const wallet of wallets) {
      const purchased = await service.read<bigint>(d.launchCurve, "guardPurchased", [wallet]);
      assert.ok(purchased <= cap && purchased > cap - smallestOutput);
      assert.equal(await service.read<bigint>(d.token, "balanceOf", [wallet]), purchased);
      assert.equal(await service.read<bigint>(d.quoteToken, "allowance", [wallet, d.launchCurve]), 0n);
      rows.push({ wallet, purchased, remaining: cap - purchased });
    }
    evidence.push({ scenario: "guard cap rounds", rows, end, receipts });
    record("Ten wallets buy to cap", `${batches.length} simultaneous rounds; all ten stop within one cbBTC unit of 34,500 tokens, before block ${end}; unused approvals revoked.`);

    await approve(wallets, 1000000n);
    const before = await service.state();
    for (const wallet of wallets) await assert.rejects(buyCall(wallet, 1n), /GuardCapExceeded/);
    assert.deepEqual((await service.state()).wallets, before.wallets);
    record("Ten over-cap attempts rejected", "One additional cbBTC unit reverts for every wallet; balances and cumulative purchases are unchanged.");

    const input = { operation: "sell" as const, amount: "100", wallets, tight: false };
    const tombBefore = await service.read<bigint>(d.token, "balanceOf", [d.tombstoneVault]);
    const sale = await service.execute((await service.preview(input)).id);
    assert.ok(sale.actions.every(a => a.status === "CONFIRMED"));
    assert.equal(await service.read<bigint>(d.token, "balanceOf", [d.tombstoneVault]) - tombBefore, 50n * 100000000n);
    for (const row of rows) {
      assert.equal(await service.read<bigint>(d.launchCurve, "guardPurchased", [row.wallet]), row.purchased);
      await assert.rejects(buyCall(row.wallet, 100000n), /GuardCapExceeded/);
    }
    record("Selling preserves guard usage", "Ten sells confirmed with 5% token fees; selling does not restore purchase allowance.");

    const block = await service.client.getBlockNumber({ cacheTime: 0 });
    assert.ok(block < end - 1n);
    await service.rpc("anvil_mine", [`0x${(end - 1n - block).toString(16)}`]);
    await assert.rejects(buyCall(wallets[0], 100000n), /GuardCapExceeded/);
    await service.rpc("evm_mine");
    assert.equal(await service.client.getBlockNumber({ cacheTime: 0 }), end);
    await buyCall(wallets[0], 100000n);
    record("Exact guard expiry", "Purchase is rejected at endBlock - 1 and allowed at endBlock; expiry uses the real contract guard.");

    const buy = { operation: "buy" as const, amount: "0.001", wallets, tight: false };
    const review = await service.preview(buy);
    const purchased = await service.execute(review.id);
    assert.ok(purchased.actions.every(a => a.status === "CONFIRMED"));
    await assert.rejects(service.execute(review.id), /expired|used/);
    await assert.rejects(service.preview({ ...buy, amount: "100" }), /insufficient/);
    await assert.rejects(service.preview({ ...buy, wallets: [service.browserWallet] }), /fixture wallets/);
    const expired = await service.preview(buy);
    const originalNow = Date.now;
    try { Date.now = () => expired.expiresAt + 1; await assert.rejects(service.execute(expired.id), /expired/); }
    finally { Date.now = originalNow; }
    for (const row of rows) assert.equal(await service.read<bigint>(d.launchCurve, "guardPurchased", [row.wallet]), row.purchased);
    record("Post-guard buys and review safety", "Ten buys succeed after expiry; duplicate/expired reviews, foreign wallets and insufficient balances are rejected.");

    const stress = await service.execute((await service.preview({ ...buy, amount: "0.01", tight: true })).id);
    assert.equal(stress.actions.filter(a => a.status === "CONFIRMED").length, 1);
    assert.equal(stress.actions.filter(a => a.status === "REVERTED").length, 9);
    record("Slippage rollback", "A simultaneous tight-slippage batch confirms one buy and reverts nine.");

    const final = await service.execute((await service.preview({ ...buy, amount: "0.1" })).id);
    assert.ok(final.actions.some(a => a.status === "CONFIRMED"));
    assert.ok(final.actions.some(a => a.status === "REVERTED"));
    assert.equal(await service.read<bigint>(d.launchCurve, "quoteReserve"), 25000000n);
    await assert.rejects(service.preview(buy), /closed/);
    const graduation = await service.execute((await service.preview({ ...buy, operation: "graduate", wallets: [wallets[0]], amount: "0" })).id);
    assert.equal(graduation.actions[0].status, "CONFIRMED");
    assert.equal(await service.read<bigint>(d.launchCurve, "quoteReserve"), 0n);
    assert.equal(await service.read<bigint>(d.launchCurve, "tokenReserve"), 0n);
    assert.equal(await service.read<bigint>(d.token, "balanceOf", [d.poolManager]), 552000n * 100000000n);
    for (const asset of [d.token, d.quoteToken]) assert.equal(await service.read<bigint>(asset, "allowance", [d.launchCurve, d.poolManager]), 0n);
    record("Graduation after guard expiry", "Buys clamp at exactly 0.25 cbBTC, excess buys revert, and graduation locks 552,000 tokens in the mock AMM.");

    const feeBefore = await service.read<bigint>(d.quoteToken, "balanceOf", [d.epochVault]);
    const ammBuy = await service.execute((await service.preview(buy)).id);
    assert.ok(ammBuy.actions.every(a => a.status === "CONFIRMED"));
    assert.equal(await service.read<bigint>(d.quoteToken, "balanceOf", [d.epochVault]) - feeBefore, 50000n);
    const ammSell = await service.execute((await service.preview({ ...input, amount: "1" })).id);
    assert.ok(ammSell.actions.every(a => a.status === "CONFIRMED"));
    record("Local mock AMM", "Ten buys and ten sells confirmed after graduation, with expected buy fees.");
    service.phase = "All guarded curve checks passed";
  } catch (e) {
    results.push({ name: "Scenario failure", passed: false, detail: e instanceof Error ? e.message : String(e) });
    service.phase = "Automated checks failed";
    throw e;
  } finally {
    service.report = results;
    await mkdir(service.dataDir, { recursive: true });
    await writeFile(path.join(service.dataDir, "evidence.json"), JSON.stringify(evidence, (_,v) => typeof v === "bigint" ? String(v) : v, 2));
    await service.saveReport();
    console.log(`Report: ${path.join(service.dataDir, "report.md")}`);
  }
}
