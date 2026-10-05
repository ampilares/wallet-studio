import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { keccak256, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { loadConfig, BASE_MAINNET_UNISWAP_V2_ROUTER, BASE_MAINNET_WETH } from "../config.js";
import { JsonStore } from "../database/JsonStore.js";
import { BundleRepository, WalletRepository } from "../database/repositories.js";
import { WalletManager } from "../wallet/WalletManager.js";
import { NonceManager } from "../wallet/NonceManager.js";
import { TokenManager } from "../token/TokenManager.js";
import { FundingPlanner } from "./FundingPlanner.js";
import { reconcileDirectTransactions, sendDirectTransaction, type DirectTransaction } from "./DirectTransactionSender.js";
import type { RpcManager } from "../chain/RpcManager.js";
import type { Bundle } from "../types.js";
import { GasManager } from "../chain/GasManager.js";

const recipient = "0x2222222222222222222222222222222222222222";
const blockHash = `0x${"11".repeat(32)}` as Hex;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "wallet-audit-test-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("wallet-audit-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  const account = privateKeyToAccount(generatePrivateKey());
  const config = loadConfig({ mode: "live", network: "sepolia", dataDir: directory });
  const store = new JsonStore<DirectTransaction[]>(path.join(directory, "direct-transactions.json"), []);
  const state = { sends: 0, signatures: 0, lostReply: false, receiptAvailable: true, hash: "0x" as Hex, chainId: 84532, beforeSign: undefined as (() => Promise<void>) | undefined };
  const receipt = () => ({ transactionHash: state.hash, blockNumber: 10n, blockHash, status: "success" });
  const client = {
    getChainId: async () => state.chainId,
    estimateGas: async () => 21000n,
    getBalance: async () => parseEther("2"),
    getTransactionCount: async () => 0,
    getBlock: async () => ({ hash: blockHash }),
    getTransactionReceipt: async () => { if (!state.receiptAvailable) throw new Error("not found"); return receipt(); },
    waitForTransactionReceipt: async () => { if (!state.receiptAvailable) throw new Error("timeout"); return receipt(); },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      state.sends++;
      state.hash = keccak256(serializedTransaction);
      const recorded = (await store.read()).at(-1)!;
      assert.equal(recorded.hash, state.hash);
      assert.equal(recorded.status, "signed", "durable identity precedes broadcast");
      if (state.lostReply) throw new Error("RPC https://provider.invalid/SECRET_KEY raw 0xSECRET_TX timeout");
      return state.hash;
    },
  };
  const rpc = { chain: baseSepolia, getPublicClient: () => client, createWalletClient: () => ({
    prepareTransactionRequest: async (request: { to: Hex; data?: Hex; value?: bigint; nonce: number }) => ({
      to: request.to, data: request.data, value: request.value, nonce: request.nonce, chainId: 84532,
      gas: 21000n, type: "eip1559", maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    }),
    signTransaction: async (request: never) => { await state.beforeSign?.(); state.signatures++; return account.signTransaction(request); },
  }) } as unknown as RpcManager;
  const nonces = new NonceManager(rpc);
  const send = () => sendDirectTransaction(config, rpc, nonces, account.address, async () => account, { to: recipient, value: 1n });
  return { config, rpc, account, store, state, nonces, directory, send };
}

test("legacy wallet and token entrypoints enforce the mainnet gate before key access", async t => {
  const f = await fixture(t);
  const config = loadConfig({ ...f.config, network: "mainnet", mainnetSendEnabled: false, wethAddress: BASE_MAINNET_WETH, dexRouterAddress: BASE_MAINNET_UNISWAP_V2_ROUTER });
  const wallets = new WalletManager(config, new WalletRepository(f.directory), f.rpc, f.nonces);
  const tokens = new TokenManager(config, f.rpc, wallets, f.nonces);
  for (const operation of [
    () => wallets.fundWallet(f.account.address, recipient, "0.1"),
    () => wallets.consolidateWallet(f.account.address, recipient),
    () => tokens.transfer(f.account.address, recipient, recipient, 1n),
    () => tokens.approve(f.account.address, recipient, recipient, 1n),
    () => tokens.mint(f.account.address, recipient, recipient, 1n),
    () => tokens.burn(f.account.address, recipient, 1n),
  ]) await assert.rejects(operation(), /Mainnet send is disabled/);
  assert.equal(f.state.signatures, 0);
  assert.equal(f.state.sends, 0);
});

test("direct sends reject the wrong chain and simulation never requests a key", async t => {
  const f = await fixture(t);
  f.state.chainId = 1;
  await assert.rejects(f.send(), /chain mismatch/);
  f.state.chainId = 84532;
  await sendDirectTransaction({ ...f.config, mode: "simulation" }, f.rpc, f.nonces, f.account.address,
    async () => { throw new Error("must not decrypt"); }, { to: recipient, value: 1n });
  assert.equal(f.state.signatures, 0);
});

test("lost direct-send response blocks fresh signatures across restart until receipt reconciliation", async t => {
  const f = await fixture(t);
  f.state.lostReply = true; f.state.receiptAvailable = false;
  await assert.rejects(f.send(), error => {
    assert.match(String(error), /outcome is unresolved/);
    assert.doesNotMatch(String(error), /SECRET|provider.invalid/);
    return true;
  });
  await assert.rejects(sendDirectTransaction(f.config, f.rpc, new NonceManager(f.rpc), f.account.address,
    async () => f.account, { to: recipient, value: 1n }), /unresolved direct transaction/);
  assert.equal((await reconcileDirectTransactions(f.config, f.rpc))[0].status, "signed");
  f.state.receiptAvailable = true;
  assert.equal((await reconcileDirectTransactions(f.config, f.rpc))[0].status, "confirmed");
  assert.equal(f.state.sends, 1);
  assert.equal(f.state.signatures, 1);
});

test("direct sends hold the bundle execution lock through signing and settlement", async t => {
  const f = await fixture(t);
  f.state.beforeSign = async () => { await assert.rejects(f.send(), /Store is locked/); };
  await f.send();
  assert.equal((await f.store.read())[0].status, "confirmed");
  assert.equal(f.state.sends, 1);
});

test("direct send refuses unresolved bundle identity, including cancelled legacy records", async t => {
  const f = await fixture(t);
  await new BundleRepository(f.directory).save({ id: "existing", chainId: 84532, actions: [
    { id: "a", walletAddress: f.account.address, status: "CANCELLED", nonce: 0, txHash: keccak256("0x01") },
  ] } as Bundle);
  await assert.rejects(f.send(), /unresolved transaction in bundle/);
  assert.equal(f.state.signatures, 0);
});

test("releasing an unsigned nonce makes it reusable without rewinding submitted nonces", async () => {
  const nonces = new NonceManager({ getPublicClient: () => ({ getTransactionCount: async () => 0 }) } as never);
  assert.equal(await nonces.reserveNonce(recipient), 0);
  await nonces.releaseNonce(recipient, 0);
  assert.equal(await nonces.reserveNonce(recipient), 0);
  await nonces.markNonceSubmitted(recipient, 0);
  assert.equal(await nonces.reserveNonce(recipient), 1);
  await nonces.releaseNonce(recipient, 1);
  assert.equal(await nonces.reserveNonce(recipient), 1);
});

test("funding plan tops up shortfalls, excludes the sender and reserves transfer fees", async t => {
  const f = await fixture(t);
  const repo = new BundleRepository(f.directory);
  const bundle: Bundle = { id: "funding", name: "funding", chainId: 84532, mode: "live", status: "CREATED", createdAt: "", updatedAt: "",
    wallets: [f.account.address, recipient, recipient], actions: [], gasPlan: { gasLimitBufferBps: 1000 },
    fundingPlan: { funderAddress: f.account.address, perWalletWei: "0", minGasWei: "0" } };
  await repo.save(bundle);
  const transfers: string[] = [];
  let balance = parseEther("0.0015");
  const wallets = { getBalance: async (address: string) => address === recipient ? balance : parseEther("1"),
    fundWallet: async (_from: string, _to: string, amount: string) => { transfers.push(amount); balance += parseEther(amount); return { simulated: false }; } };
  const gas = { getGasPrice: async () => ({ maxFeePerGas: 2n }), estimateWalletGas: async () => 21000n, applyBuffer: (value: bigint) => value * 11n / 10n };
  const planner = new FundingPlanner(f.config, wallets as never, gas as never, repo);
  const report = await planner.analyze(bundle);
  assert.equal(report.totalRequiredWei, parseEther("0.0005").toString());
  assert.equal(report.shortfalls.length, 1);
  assert.ok(BigInt(report.totalWithFeeReserveWei) > BigInt(report.totalRequiredWei));
  await planner.executePlan(bundle.id);
  await planner.executePlan(bundle.id);
  assert.deepEqual(transfers, ["0.0005"]);
});

test("token deployment simulation returns constructor data without pretend executable bytecode", async t => {
  const f = await fixture(t);
  const manager = new TokenManager({ ...f.config, mode: "simulation" }, f.rpc, {} as never, f.nonces);
  const result = await manager.deployToken({ from: f.account.address, name: "QA", symbol: "QA", initialSupply: 1n });
  assert.equal(result.deploymentSupported, false);
  assert.equal("bytecode" in result, false);
  assert.match(result.constructorData, /^0x[0-9a-f]+$/);
});

test("gas distribution sanitizes nested provider failures before returning JSON results", async t => {
  const f = await fixture(t);
  const gas = new GasManager(f.config, f.rpc, { getBalance: async () => 0n,
    fundWallet: async () => { throw new Error("Provider https://provider.invalid/SECRET_KEY failed"); } });
  const result = await gas.distributeGas(f.account.address, [recipient], "0.1");
  assert.equal(result.results[0].ok, false);
  assert.doesNotMatch(JSON.stringify(result), /provider.invalid|SECRET_KEY/);
});
