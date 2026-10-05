import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { keccak256, type Address, type Hex } from "viem";
import { JsonStore } from "./database/JsonStore.js";
import { BundleRepository, TransactionRepository } from "./database/repositories.js";
import { ExecutionEngine } from "./core/ExecutionEngine.js";
import { BASE_MAINNET_UNISWAP_V2_ROUTER, BASE_MAINNET_WETH, loadConfig } from "./config.js";
import { encryptSecret, decryptSecret } from "./wallet/crypto.js";
import { Bundler } from "./core/Bundler.js";
import { Simulator } from "./simulation/Simulator.js";
import { assertFreshDryRun, assertGarlicSpendCeilings, bundleFingerprint, MOCK_ROUTER } from "./core/transactionSafety.js";
import { hardenSensitiveFiles } from "./security/sensitiveFiles.js";
import { execFileSync } from "node:child_process";
import { chmod, stat } from "node:fs/promises";
import { GarlicBuyPresets } from "./core/GarlicBuyPresets.js";
import { NonceManager } from "./wallet/NonceManager.js";
import type { Bundle } from "./types.js";
import { safeCliError, safeRpcError } from "./security/errors.js";
import { BundleBuilder } from "./core/BundleBuilder.js";

const wallet = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const signed = "0x010203" as Hex;
const expectedHash = keccak256(signed);

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "bundler-security-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("bundler-security-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function sampleBundle(): Bundle {
  return {
    id: "bundle", chainId: 84532, name: "security regression", wallets: [wallet], token,
    actions: [{ id: "action", walletAddress: wallet, type: "TRANSFER", target: token,
      calldata: "0x", valueWei: "1", status: "CREATED" }],
    gasPlan: { gasLimitBufferBps: 1500 }, mode: "live", status: "CREATED",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

async function harness(directory: string, network: "sepolia" | "mainnet" = "sepolia") {
  const config = loadConfig({ dataDir: directory, mode: "live", network,
    ...(network === "mainnet" ? { wethAddress: BASE_MAINNET_WETH,
      dexRouterAddress: BASE_MAINNET_UNISWAP_V2_ROUTER } : {}) });
  const bundles = new BundleRepository(directory);
  const txs = new TransactionRepository(directory);
  await bundles.save({ ...sampleBundle(), chainId: network === "mainnet" ? 8453 : 84532 });
  let sends = 0;
  let nonce = 0;
  let receiptAvailable = false;
  let sendError = false;
  let wrongHash = false;
  const receipt = { transactionHash: expectedHash, status: "success", gasUsed: 21000n, effectiveGasPrice: 1n, blockNumber: 10n };
  const client = {
    getChainId: async () => network === "mainnet" ? 8453 : 84532,
    estimateGas: async () => 21000n,
    getTransactionReceipt: async () => {
      if (!receiptAvailable) throw new Error("Receipt not found");
      return receipt;
    },
    waitForTransactionReceipt: async () => {
      if (!receiptAvailable) throw new Error("Receipt timeout");
      return receipt;
    },
    sendRawTransaction: async () => {
      const persisted = (await bundles.get("bundle"))!.actions[0]!;
      assert.equal(persisted.status, "SIGNED");
      assert.equal(persisted.txHash, expectedHash);
      assert.equal(persisted.nonce, 0);
      assert.equal((await txs.list())[0]!.txHash, expectedHash);
      sends++;
      if (sendError) throw new Error("Connection lost after accepting transaction");
      return wrongHash ? `0x${"00".repeat(32)}` : expectedHash;
    },
  };
  const rpc = {
    getPublicClient: () => client,
    createWalletClient: () => ({ prepareTransactionRequest: async () => ({}), signTransaction: async () => signed }),
    chain: {},
  };
  const gas = { getGasPrice: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), applyBuffer: (g: bigint) => g };
  const wallets = { getAccount: async () => ({ address: wallet }) };
  const nonces = { reserveNonce: async () => nonce++, releaseNonce: async () => {}, markNonceSubmitted: async () => {} };
  const simulator = { simulateBundle: async () => ({ ok: true, issues: [] }) };
  const engine = () => new ExecutionEngine(config, rpc as never, gas as never,
    wallets as never, nonces as never, simulator as never, bundles, txs);
  return { config, bundles, txs, engine, sends: () => sends, nonce: () => nonce,
    confirm: () => { receiptAvailable = true; }, loseResponse: () => { sendError = true; },
    tamperHash: () => { wrongHash = true; }, tamperReceipt: () => { receipt.transactionHash = keccak256("0x00"); } };
}

test("manifest and lockfile have only the reviewed direct dependencies", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@phosphor-icons/react", "commander", "dotenv", "react", "react-dom", "viem", "zod"]);
  for (const group of ["dependencies", "devDependencies"]) {
    assert.deepEqual(manifest[group], lock.packages[""][group]);
    for (const [name, version] of Object.entries(manifest[group])) {
      assert.equal(version, lock.packages[`node_modules/${name}`].version);
    }
  }
  assert.doesNotMatch(JSON.stringify(lock), /oscar-redis|ioredis-xyz|redis-type-intel|ulid-intel/);
});

test("wallet encryption rejects missing, short and publicly known passphrases", () => {
  for (const passphrase of ["", "short", " ".repeat(20), "change-me-to-a-strong-passphrase"]) {
    assert.throws(() => encryptSecret("test secret", passphrase), /WALLET_PASSPHRASE/);
  }
  const passphrase = "test-only unique long passphrase";
  const encrypted = encryptSecret("test secret", passphrase);
  assert.equal(decryptSecret(encrypted.ciphertext, encrypted.iv, encrypted.salt, passphrase), "test secret");
  assert.throws(() => decryptSecret(encrypted.ciphertext, encrypted.iv, encrypted.salt, "incorrect passphrase"));
});

test("live mode has no mock adapter and uses the real router when configured", () => {
  const oldRouter = process.env.DEX_ROUTER_ADDRESS;
  const oldWeth = process.env.WETH_ADDRESS;
  try {
    delete process.env.DEX_ROUTER_ADDRESS;
    delete process.env.WETH_ADDRESS;
    const live = Bundler.create({ mode: "live", network: "sepolia" });
    assert.throws(() => live.dex.default(), /No DEX/);
    assert.throws(() => live.dex.get("mock"), /not found/);
    const configured = Bundler.create({ mode: "live", network: "mainnet",
      dexRouterAddress: BASE_MAINNET_UNISWAP_V2_ROUTER, wethAddress: BASE_MAINNET_WETH });
    assert.equal(configured.dex.default().name, "uniswap-v2");
    assert.equal(configured.dex.default().wrappedNativeToken, BASE_MAINNET_WETH);
  } finally {
    if (oldRouter === undefined) delete process.env.DEX_ROUTER_ADDRESS; else process.env.DEX_ROUTER_ADDRESS = oldRouter;
    if (oldWeth === undefined) delete process.env.WETH_ADDRESS; else process.env.WETH_ADDRESS = oldWeth;
  }
});

test("mainnet configuration accepts only the embedded canonical Base deployments", () => {
  assert.throws(() => loadConfig({ network: "mainnet", wethAddress: wallet,
    dexRouterAddress: BASE_MAINNET_UNISWAP_V2_ROUTER }), /WETH_ADDRESS/);
  assert.throws(() => loadConfig({ network: "mainnet", wethAddress: BASE_MAINNET_WETH,
    dexRouterAddress: token }), /DEX_ROUTER_ADDRESS/);
  const config = loadConfig({ network: "mainnet", wethAddress: BASE_MAINNET_WETH,
    dexRouterAddress: BASE_MAINNET_UNISWAP_V2_ROUTER });
  assert.equal(config.wethAddress, BASE_MAINNET_WETH);
  assert.equal(config.dexRouterAddress, BASE_MAINNET_UNISWAP_V2_ROUTER);
});

test("mainnet dry runs are bound to the exact transaction state", () => {
  const bundle = { ...sampleBundle(), chainId: 8453 };
  bundle.dryRun = { chainId: 8453, fingerprint: bundleFingerprint(bundle), verifiedAt: new Date().toISOString() };
  assert.doesNotThrow(() => assertFreshDryRun(bundle));
  bundle.actions[0]!.valueWei = "2";
  assert.throws(() => assertFreshDryRun(bundle), /exact bundle/);
  bundle.actions[0]!.valueWei = "1";
  bundle.dryRun = { chainId: 8453, fingerprint: bundleFingerprint(bundle), verifiedAt: new Date().toISOString() };
  bundle.gasPlan.maxFeePerGas = "2";
  assert.throws(() => assertFreshDryRun(bundle), /exact bundle/);
});

test("mainnet executor refuses sends without both explicit flag and prior dry run", async (t) => {
  const h = await harness(await temporary(t), "mainnet");
  await assert.rejects(h.engine().executeBundle("bundle"), /Mainnet send is disabled/);
  assert.equal(h.sends(), 0);
  assert.equal(h.nonce(), 0);
  h.config.mainnetSendEnabled = true;
  await assert.rejects(h.engine().executeBundle("bundle"), /successful dry run/);
  assert.equal(h.sends(), 0);
  assert.equal(h.nonce(), 0);
});

test("Garlic spend ceilings and factory allocation caps fail before signing", () => {
  const bundle = { ...sampleBundle(), actions: [
    { ...sampleBundle().actions[0]!, id: "one", type: "CONTRACT_CALL" as const, valueWei: "6",
      params: { garlicPreset: "buyNative", walletSpendCeilingWei: "10", quotedTokens: "4", factoryRemainingTokens: "10" } },
    { ...sampleBundle().actions[0]!, id: "two", type: "CONTRACT_CALL" as const, valueWei: "5",
      params: { garlicPreset: "buyAdapter", walletSpendCeilingWei: "10", quotedTokens: "4", factoryRemainingTokens: "10" } },
  ] };
  assert.throws(() => assertGarlicSpendCeilings(bundle), /spend ceiling/);
  bundle.actions[1]!.valueWei = "4";
  bundle.actions[1]!.params!.quotedTokens = "11";
  assert.throws(() => assertGarlicSpendCeilings(bundle), /allocation cap/);
});

test("sensitive config and stores receive restrictive permissions", async (t) => {
  const root = await temporary(t);
  const legacyData = path.join(root, "data");
  const data = path.join(legacyData, "base-sepolia");
  await mkdir(data, { recursive: true });
  const files = [path.join(root, ".env"), ...["wallets.json", "bundles.json", "vault.json", "nft-campaigns.json", "mainnet-funding.json", "direct-transactions.json"].map(file => path.join(data, file)),
    path.join(legacyData, "wallets.json"), path.join(legacyData, "bundles.json")];
  for (const file of files) {
    await writeFile(file, "[]");
    if (process.platform === "win32") {
      execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:F"], { windowsHide: true, stdio: "ignore" });
      assert.match(execFileSync("icacls.exe", [file], { encoding: "utf8", windowsHide: true }), /Everyone/i);
    } else await chmod(file, 0o666);
  }
  hardenSensitiveFiles(data, root);
  for (const file of files) {
    if (process.platform === "win32") {
      const acl = execFileSync("icacls.exe", [file], { encoding: "utf8", windowsHide: true });
      assert.doesNotMatch(acl, /Everyone|Authenticated Users|BUILTIN\\Users/i);
    } else {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  }
});

test("Garlic buyNative preset reads chain caps and records bounded calldata", async () => {
  const factory = "0x3333333333333333333333333333333333333333" as Address;
  const curve = "0x4444444444444444444444444444444444444444" as Address;
  let added: Record<string, unknown> | undefined;
  const readContract = async ({ functionName }: { functionName: string }) => ({
    factory, quote: BASE_MAINNET_WETH, Smax: 100n, saleAllocation: 80n, sold: 20n,
    tradePaused: false, isCurve: true, quoteBuy: [30n, 10n, 1n],
  } as Record<string, unknown>)[functionName];
  const builder = {
    get: async () => ({ ...sampleBundle(), actions: [] }),
    addAction: async (_id: string, input: Record<string, unknown>) => { added = input; return sampleBundle(); },
  };
  const config = loadConfig({ network: "sepolia", garlicFactoryAddress: factory });
  const presets = new GarlicBuyPresets(config,
    { chain: { id: 84532 }, getPublicClient: () => ({ readContract }) } as never, builder as never);
  await presets.addBuyNative({ bundleId: "bundle", wallet, curve, spendWei: 10n,
    walletSpendCeilingWei: 12n, minTokens: 25n, deadline: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(added?.type, "CONTRACT_CALL");
  assert.equal(added?.valueWei, "10");
  assert.equal((added?.params as Record<string, unknown>).factoryRemainingTokens, "60");
  await assert.rejects(presets.addBuyNative({ bundleId: "bundle", wallet, curve, spendWei: 13n,
    walletSpendCeilingWei: 12n, minTokens: 25n, deadline: Math.floor(Date.now() / 1000) + 600 }), /spend ceiling/);
  const unboundMainnet = new GarlicBuyPresets(loadConfig({ network: "mainnet",
    wethAddress: BASE_MAINNET_WETH, dexRouterAddress: BASE_MAINNET_UNISWAP_V2_ROUTER }),
  { chain: { id: 8453 }, getPublicClient: () => ({ readContract }) } as never, builder as never);
  await assert.rejects(unboundMainnet.addBuyNative({ bundleId: "bundle", wallet, curve, spendWei: 10n,
    walletSpendCeilingWei: 12n, minTokens: 25n, deadline: Math.floor(Date.now() / 1000) + 600 }), /GARLIC_FACTORY_ADDRESS/);
});

test("Garlic adapter preset binds self recipients and the on-chain route", async () => {
  const factory = "0x3333333333333333333333333333333333333333" as Address;
  const curve = "0x4444444444444444444444444444444444444444" as Address;
  const adapter = "0x5555555555555555555555555555555555555555" as Address;
  let added: Record<string, unknown> | undefined;
  let quote: Address = BASE_MAINNET_WETH;
  let sold = 20n;
  let graduated = false;
  const readContract = async ({ functionName }: { functionName: string }) => ({
    factory, wrappedNative: BASE_MAINNET_WETH, quote,
    Smax: 100n, saleAllocation: 80n, sold, tradePaused: false,
    isCurve: true, enabled: true, graduated,
  } as Record<string, unknown>)[functionName];
  const builder = {
    get: async () => ({ ...sampleBundle(), actions: [] }),
    addAction: async (_id: string, input: Record<string, unknown>) => { added = input; return sampleBundle(); },
  };
  const presets = new GarlicBuyPresets(loadConfig({ network: "sepolia", garlicFactoryAddress: factory,
    garlicBuyAdapterAddress: adapter }),
  { chain: { id: 84532 }, getPublicClient: () => ({ readContract }) } as never, builder as never);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  await presets.addAdapterBuy({ bundleId: "bundle", wallet, curve, spendWei: 10n,
    walletSpendCeilingWei: 12n, minQuote: 9n, minTokens: 25n, routeFee: 0, deadline });
  assert.equal(added?.target, adapter);
  assert.equal((added?.params as Record<string, unknown>).garlicPreset, "buyAdapter");
  await assert.rejects(presets.addAdapterBuy({ bundleId: "bundle", wallet, curve, spendWei: 10n,
    walletSpendCeilingWei: 12n, minQuote: 9n, minTokens: 25n, routeFee: 3000, deadline }), /route fee/);
  await assert.rejects(presets.addAdapterBuy({ bundleId: "bundle", wallet, curve, spendWei: 10n,
    walletSpendCeilingWei: 12n, minQuote: 9n, minTokens: 25n, routeFee: 1.5, deadline }), /route fee/);
  graduated = true;
  quote = token;
  sold = 80n;
  await presets.addAdapterBuy({ bundleId: "bundle", wallet, curve, spendWei: 10n,
    walletSpendCeilingWei: 12n, minQuote: 9n, minTokens: 25n, routeFee: 3000, deadline, graduated: true });
  assert.equal((added?.params as Record<string, unknown>).factoryCapApplies, false);
});

test("persisted mock bundles cannot bypass the live executor guard", async (t) => {
  const h = await harness(await temporary(t));
  const bundle = sampleBundle();
  bundle.actions[0]!.target = MOCK_ROUTER;
  await h.bundles.save(bundle);
  await assert.rejects(h.engine().executeBundle(bundle.id), /Mock DEX/);
  assert.equal(h.sends(), 0);
  assert.equal(h.nonce(), 0);
});

test("live simulator rejects mock actions instead of reporting paper success", async (t) => {
  const directory = await temporary(t);
  const bundle = sampleBundle();
  bundle.actions[0]!.target = MOCK_ROUTER;
  const simulator = new Simulator(loadConfig({ mode: "live", dataDir: directory, network: "sepolia" }),
    { getPublicClient: () => ({}) } as never,
    { estimateBundleGas: async () => ({ estimatedCostEth: "0" }) } as never,
    { getBalance: async () => 10n ** 18n } as never, new BundleRepository(directory));
  const report = await simulator.simulateBundle(bundle);
  assert.equal(report.ok, false);
  assert.match(report.issues[0]!.message, /Mock DEX/);
});

test("receipt timeout preserves identity across retries, restart and confirmation", async (t) => {
  const h = await harness(await temporary(t));
  await h.engine().executeBundle("bundle");
  assert.equal(h.sends(), 1);
  for (const recover of ["retryFailed", "retryPending", "resumeBundle", "executeBundle"] as const) {
    await h.engine()[recover]("bundle");
  }
  assert.equal(h.sends(), 1);
  assert.equal(h.nonce(), 1);
  h.confirm();
  const recovered = await h.engine().resumeBundle("bundle");
  assert.equal(recovered.status, "COMPLETED");
  assert.equal(recovered.actions[0]!.txHash, expectedHash);
  assert.equal((await h.txs.list())[0]!.status, "CONFIRMED");
  assert.equal(h.sends(), 1);
});

test("lost broadcast response and dishonest RPC hash never trigger another send", async (t) => {
  for (const failure of ["loseResponse", "tamperHash"] as const) {
    const h = await harness(await temporary(t));
    h[failure]();
    await h.engine().executeBundle("bundle");
    await h.engine().retryFailed("bundle");
    assert.equal(h.sends(), 1);
    assert.equal((await h.bundles.get("bundle"))!.actions[0]!.txHash, expectedHash);
    h.confirm();
    assert.equal((await h.engine().reconcileBundle("bundle")).status, "COMPLETED");
  }
});

test("legacy ambiguous submissions fail closed even without a hash", async (t) => {
  const h = await harness(await temporary(t));
  const bundle = sampleBundle();
  bundle.actions[0]!.status = "TIMEOUT";
  await h.bundles.save(bundle);
  await h.engine().retryFailed("bundle");
  assert.equal(h.sends(), 0);
});

test("concurrent executor instances cannot send the same action twice", async (t) => {
  const h = await harness(await temporary(t));
  const results = await Promise.allSettled([h.engine().executeBundle("bundle"), h.engine().executeBundle("bundle")]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.equal(h.sends(), 1);
});

test("concurrent store instances preserve every inserted record", async (t) => {
  const file = path.join(await temporary(t), "wallets.json");
  await Promise.all(Array.from({ length: 30 }, (_, index) =>
    new JsonStore<number[]>(file, []).update(async (rows) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [...rows, index];
    })));
  assert.deepEqual((await new JsonStore<number[]>(file, []).read()).sort((a, b) => a - b),
    Array.from({ length: 30 }, (_, index) => index));
});

test("corrupt or unreadable stores are not replaced with empty data", async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, "wallets.json");
  await writeFile(file, "corrupt original wallet data");
  const store = new JsonStore<number[]>(file, []);
  await assert.rejects(store.update(() => []));
  await assert.rejects(store.ensure());
  await assert.rejects(store.write([]));
  assert.equal(await readFile(file, "utf8"), "corrupt original wallet data");
  const inaccessible = path.join(directory, "directory.json");
  await mkdir(inaccessible);
  await assert.rejects(new JsonStore(inaccessible, []).ensure());
});

test("failed update leaves the prior data intact and releases its lock", async (t) => {
  const store = new JsonStore<number[]>(path.join(await temporary(t), "state.json"), []);
  await store.write([1]);
  await assert.rejects(store.update(() => { throw new Error("failed mutation"); }));
  assert.deepEqual(await store.read(), [1]);
  await store.update((rows) => [...rows, 2]);
  assert.deepEqual(await store.read(), [1, 2]);
});

function runNode(code: string, input = ""): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

test("store updates are serialized across separate processes", async (t) => {
  const file = path.join(await temporary(t), "state.json");
  const moduleUrl = new URL("./database/JsonStore.js", import.meta.url).href;
  const code = `import { JsonStore } from ${JSON.stringify(moduleUrl)};
    const store = new JsonStore(${JSON.stringify(file)}, []);
    for (let i = 0; i < 10; i++) await store.update(rows => [...rows, process.pid]);`;
  const results = await Promise.all([runNode(code), runNode(code), runNode(code)]);
  for (const result of results) assert.equal(result.code, 0, result.output);
  assert.equal((await new JsonStore<number[]>(file, []).read()).length, 30);
});

test("stdin key import validates without echoing the secret", async () => {
  const moduleUrl = new URL("./cli/secretInput.js", import.meta.url).href;
  const code = `import { readPrivateKey } from ${JSON.stringify(moduleUrl)};
    try { await readPrivateKey(true); console.log('accepted'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const key = "0x" + "ab".repeat(32);
  const valid = await runNode(code, key + "\n");
  assert.equal(valid.code, 0);
  assert.equal(valid.output.trim(), "accepted");
  const invalid = await runNode(code, "invalid-sensitive-key");
  assert.equal(invalid.code, 1);
  assert.doesNotMatch(invalid.output, /invalid-sensitive-key/);
});

test("unimplemented token deployment is blocked before loading keys or sending", async () => {
  const bundler = Bundler.create({ mode: "live", network: "sepolia" });
  await assert.rejects(bundler.tokens.deployToken({ from: wallet, name: "Token", symbol: "T", initialSupply: 1n }), /no reviewed compiled artifact/);
});

test("passphrase rotation updates all keys atomically and preserves data on failure", async (t) => {
  const directory = await temporary(t);
  const oldPassphrase = "test-only original passphrase";
  const newPassphrase = "test-only replacement passphrase";
  const bundler = Bundler.create({ mode: "simulation", network: "sepolia", dataDir: directory, walletPassphrase: oldPassphrase });
  const first = await bundler.wallets.importWallet(`0x${"01".repeat(32)}`);
  const second = await bundler.wallets.importWallet(`0x${"02".repeat(32)}`);
  const original = await readFile(path.join(directory, "wallets.json"), "utf8");
  await assert.rejects(bundler.wallets.rotatePassphrase("incorrect", newPassphrase));
  assert.equal(await readFile(path.join(directory, "wallets.json"), "utf8"), original);
  assert.equal(await bundler.wallets.rotatePassphrase(oldPassphrase, newPassphrase), 2);
  assert.equal((await bundler.wallets.getAccount(first.address)).address, first.address);
  assert.equal((await bundler.wallets.getAccount(second.address)).address, second.address);
  const old = Bundler.create({ mode: "simulation", network: "sepolia", dataDir: directory, walletPassphrase: oldPassphrase });
  await assert.rejects(old.wallets.getAccount(first.address));
});

test("wallet key errors do not disclose the supplied key", async (t) => {
  const bundler = Bundler.create({ network: "sepolia", dataDir: await temporary(t), walletPassphrase: "test-only unique passphrase" });
  const invalidKey = `0x${"00".repeat(32)}` as Hex;
  await assert.rejects(bundler.wallets.importWallet(invalidKey), (error: Error) => {
    assert.equal(error.message, "Invalid private key");
    assert.ok(!error.message.includes(invalidKey));
    return true;
  });
});

test("out-of-order nonce submission cannot reserve an already submitted nonce", async () => {
  const nonces = new NonceManager({ getPublicClient: () => ({ getTransactionCount: async () => 0 }) } as never);
  assert.equal(await nonces.reserveNonce(wallet), 0);
  assert.equal(await nonces.reserveNonce(wallet), 1);
  await nonces.markNonceSubmitted(wallet, 1);
  assert.equal(await nonces.reserveNonce(wallet), 2);
  await nonces.reconcileNonces(wallet);
  assert.deepEqual(nonces.getState(wallet)!.reserved, [0, 2]);
  assert.equal(await nonces.reserveNonce(wallet), 3);
});

test("legacy and wrong-chain bundles cannot execute or reconcile", async (t) => {
  for (const chainId of [undefined, 8453, 4663]) {
    const h = await harness(await temporary(t));
    await h.bundles.save({ ...sampleBundle(), chainId });
    await assert.rejects(h.engine().executeBundle("bundle"), /chainId|chain mismatch/);
    await assert.rejects(h.engine().reconcileBundle("bundle"), /chainId|chain mismatch/);
    assert.equal(h.sends(), 0);
    assert.equal(h.nonce(), 0);
  }
});

test("a new bundle cannot bypass an unresolved transaction in another bundle", async t => {
  const h = await harness(await temporary(t));
  const first = await h.engine().executeBundle("bundle");
  assert.equal(h.sends(), 1);
  await h.bundles.save({ ...sampleBundle(), id: "another" });
  await assert.rejects(h.engine().executeBundle("another"), /unresolved transaction in bundle bundle/);
  assert.equal(h.sends(), 1);
  assert.equal(first.actions[0].txHash, expectedHash);
});

test("replacement receipts cannot falsely confirm the originally signed bundle action", async t => {
  const h = await harness(await temporary(t));
  h.confirm(); h.tamperReceipt();
  assert.equal((await h.engine().executeBundle("bundle")).actions[0].status, "SUBMITTED");
  assert.equal((await h.engine().reconcileBundle("bundle")).actions[0].status, "SUBMITTED");
  assert.equal(h.sends(), 1);
});

test("stale bundle edits, removal and deletion cannot erase a concurrent signed transaction", async t => {
  const h = await harness(await temporary(t));
  const stale = await h.bundles.get("bundle");
  await h.engine().executeBundle("bundle");
  await assert.rejects(h.bundles.save(stale!), /signed transaction history/);
  const current = (await h.bundles.get("bundle"))!;
  await assert.rejects(h.bundles.save({ ...current, actions: [] }), /signed transaction history/);
  await assert.rejects(h.bundles.delete("bundle"), /signed transaction history/);
  assert.equal((await h.bundles.get("bundle"))!.actions[0].txHash, expectedHash);
  h.confirm();
  await h.engine().reconcileBundle("bundle");
  await assert.rejects(h.bundles.save(current), /signed transaction history/);
});

test("RPC diagnostics and CLI failures exclude provider URLs and raw payloads", () => {
  const payload = `0x${"ab".repeat(300)}`;
  const error = new Error(`RPC https://provider.invalid/v2/PRIVATE_API_KEY request ${payload} timed out`);
  for (const message of [safeRpcError(error), safeCliError(error)]) {
    assert.doesNotMatch(message, /PRIVATE_API_KEY|provider.invalid/);
    assert.ok(!message.includes(payload));
  }
  assert.match(safeRpcError(error), /timed out/);
});

test("bundle fee summary multiplies gas units by price and marks legacy costs unknown", async t => {
  const repo = new BundleRepository(await temporary(t));
  const config = loadConfig({ network: "sepolia" });
  const builder = new BundleBuilder(config, repo, {} as never, {} as never);
  const bundle = sampleBundle();
  bundle.actions[0].gasUsed = "21000";
  bundle.actions[0].effectiveGasPrice = "1000000000";
  await repo.save(bundle);
  assert.equal((await builder.summarize(bundle.id)).gasSpentWei, "21000000000000");
  delete bundle.actions[0].effectiveGasPrice;
  await repo.save(bundle);
  assert.equal((await builder.summarize(bundle.id)).gasSpentWei, null);
});

test("new Base bundles retain chain identity across cloning and block cross-chain operations", async (t) => {
  const directory = await temporary(t);
  const sepolia = Bundler.create({ network: "sepolia", mode: "simulation", dataDir: directory });
  const mainnet = Bundler.create({ network: "mainnet", mode: "simulation", dataDir: directory,
    dexRouterAddress: BASE_MAINNET_UNISWAP_V2_ROUTER, wethAddress: BASE_MAINNET_WETH });
  const original = await sepolia.bundles.createBundle("Base Sepolia");
  assert.equal(original.chainId, 84532);
  assert.equal((await sepolia.bundles.cloneBundle(original.id)).chainId, 84532);
  assert.equal((await mainnet.bundles.createBundle("Base mainnet")).chainId, 8453);
  await assert.rejects(mainnet.bundles.cloneBundle(original.id), /chain mismatch/);
  await assert.rejects(mainnet.simulator.simulateBundle(original), /chain mismatch/);
  await assert.rejects(mainnet.funding.executePlan(original.id), /chain mismatch/);
  // Inspection is still available, without changing the stored identity.
  assert.equal((await mainnet.bundles.get(original.id))!.chainId, 84532);
});

test("CLI rejects misspelled networks and modes before any operation", async () => {
  const cliUrl = new URL("./cli/index.js", import.meta.url).href;
  for (const [option, value] of [["--network", "mainent"], ["--mode", "simulaton"]]) {
    const result = await runNode(`process.argv = ['node', 'bundler', ${JSON.stringify(option)}, ${JSON.stringify(value)}, 'health']; await import(${JSON.stringify(cliUrl)});`);
    assert.equal(result.code, 1);
    assert.match(result.output, /invalid/);
  }
});
