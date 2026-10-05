import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_MAINNET_UNISWAP_V2_ROUTER, BASE_MAINNET_WETH, loadConfig, type ConfigOverrides } from "../config.js";
import { Bundler } from "../core/Bundler.js";
import { getChain, normalizeNetwork, alchemyHttpUrl, alchemyWsUrl, sequencerUrl } from "./networks.js";
import { RpcManager } from "./RpcManager.js";
import { SequencerClient } from "./SequencerClient.js";

const mainnetConfig = (overrides: ConfigOverrides = {}) => loadConfig({
  network: "mainnet", wethAddress: BASE_MAINNET_WETH,
  dexRouterAddress: BASE_MAINNET_UNISWAP_V2_ROUTER, ...overrides,
});

test("Base aliases resolve to the intended chain and provider endpoints", () => {
  for (const network of ["mainnet", "base", "base-mainnet"] as const) {
    assert.equal(getChain(network).id, 8453);
    assert.equal(normalizeNetwork(network), "mainnet");
    assert.equal(getChain(network).rpcUrls.default.http[0], "https://mainnet.base.org");
    assert.equal(alchemyHttpUrl(network, "test-key"), "https://base-mainnet.g.alchemy.com/v2/test-key");
    assert.equal(sequencerUrl(network), "https://mainnet-sequencer.base.org");
  }
  for (const network of ["sepolia", "testnet", "base-sepolia"] as const) {
    assert.equal(getChain(network).id, 84532);
    assert.equal(normalizeNetwork(network), "sepolia");
    assert.equal(getChain(network).rpcUrls.default.http[0], "https://sepolia.base.org");
    assert.equal(alchemyWsUrl(network, "test-key"), "wss://base-sepolia.g.alchemy.com/v2/test-key");
    assert.equal(sequencerUrl(network), "https://sepolia-sequencer.base.org");
  }
  assert.throws(() => normalizeNetwork("ethereum"), /Unsupported Base network/);
});

test("default data directories follow the effective network and preserve explicit overrides", () => {
  const oldNetwork = process.env.BUNDLER_NETWORK;
  const oldDirectory = process.env.DATA_DIR;
  try {
    delete process.env.BUNDLER_NETWORK;
    delete process.env.DATA_DIR;
    assert.equal(loadConfig().network, "sepolia");
    assert.equal(loadConfig().dataDir, "./data/base-sepolia");
    process.env.BUNDLER_NETWORK = "mainnet";
    assert.equal(mainnetConfig().dataDir, "./data/base-mainnet");
    assert.equal(loadConfig({ network: "testnet" }).dataDir, "./data/base-sepolia");
    process.env.DATA_DIR = "./custom-store";
    assert.equal(loadConfig({ network: "sepolia" }).dataDir, "./custom-store");
    assert.equal(mainnetConfig({ dataDir: "./override" }).dataDir, "./override");
    assert.throws(() => loadConfig({ network: "typo" as "mainnet" }), /Unsupported/);
  } finally {
    if (oldNetwork === undefined) delete process.env.BUNDLER_NETWORK; else process.env.BUNDLER_NETWORK = oldNetwork;
    if (oldDirectory === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDirectory;
  }
});

test("RPC fallback contains only read endpoints and WS stays opt-in", () => {
  for (const network of ["mainnet", "sepolia"] as const) {
    const config = network === "mainnet" ? mainnetConfig({ rpcUrl: "", rpcUrlSecondary: "", alchemyApiKey: "", wsUrl: "" }) : loadConfig({ network, rpcUrl: "", rpcUrlSecondary: "", alchemyApiKey: "", wsUrl: "" });
    const rpc = new RpcManager(config);
    assert.deepEqual(rpc.getHttpUrls(), [getChain(network).rpcUrls.default.http[0]]);
    assert.equal(rpc.getWsTransport(), null);
    const custom = new RpcManager({ ...config, rpcUrl: "https://primary.invalid", rpcUrlSecondary: "https://secondary.invalid" });
    assert.deepEqual(custom.getHttpUrls(), ["https://primary.invalid", "https://secondary.invalid", getChain(network).rpcUrls.default.http[0]]);
    assert.equal(new RpcManager({ ...config, alchemyApiKey: "test-key" }).getHttpUrls()[0], alchemyHttpUrl(network, "test-key"));
  }
});

test("health rejects a responsive RPC on the wrong chain", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    assert.equal(body.method, "eth_chainId");
    return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x1" });
  });
  const rpc = new RpcManager(mainnetConfig({ rpcUrl: "", rpcUrlSecondary: "", alchemyApiKey: "" }));
  const health = await rpc.healthCheck();
  assert.equal(health.length, 1);
  assert.equal(health[0]!.ok, false);
  assert.match(health[0]!.error!, /expected 8453, received 1/);
});

test("disabled sequencer is not contacted during health", async (t) => {
  const bundler = Bundler.create({ network: "sepolia", useSequencer: false });
  t.mock.method(bundler.rpc, "healthCheck", async () => []);
  t.mock.method(bundler.sequencer, "ping", async () => { throw new Error("must not contact sequencer"); });
  assert.equal((await bundler.health()).sequencer, null);
});

test("sequencer health requires the selected chain and sends only supplied signed bytes", async (t) => {
  const requests: { method: string; params: string[] }[] = [];
  const hash = `0x${"ab".repeat(32)}`;
  let reportedChain = "0x14a34";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://sepolia-sequencer.base.org");
    assert.ok(init.signal);
    const body = JSON.parse(String(init.body));
    requests.push(body);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_chainId" ? reportedChain : hash });
  });
  const sequencer = new SequencerClient("sepolia");
  assert.equal((await sequencer.ping()).ok, true);
  reportedChain = "0x2105";
  assert.equal((await sequencer.ping()).ok, false);
  assert.equal(await sequencer.sendRawTransaction("0x010203"), hash);
  assert.deepEqual(requests.at(-1)!.params, ["0x010203"]);
  assert.equal(requests.at(-1)!.method, "eth_sendRawTransaction");
});
