import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { getChain, alchemyHttpUrl } from "../chain/networks.js";
import { RpcManager } from "../chain/RpcManager.js";
import { CurveService, type Deployment } from "./service.js";
import { StudioService } from "../studio/service.js";

test("local execution has no public provider fallback or sequencer", () => {
  const config = loadConfig({ network: "local", mode: "live", rpcUrl: "http://127.0.0.1:8546", rpcUrlSecondary: "https://mainnet.base.org", useSequencer: false });
  assert.equal(getChain("local").id, 31337);
  assert.deepEqual(new RpcManager(config).getHttpUrls(), ["http://127.0.0.1:8546/"]);
  assert.throws(() => new RpcManager({ ...config, rpcUrl: "https://mainnet.base.org" }), /loopback/);
  assert.throws(() => new RpcManager({ ...config, useSequencer: true }), /sequencer/);
  assert.throws(() => alchemyHttpUrl("local", "unused"), /cannot use Alchemy/);
});
test("curve fixture rejects public networks and non-loopback RPCs before initialization", () => {
  const studio = new StudioService("unused-test-directory");
  const address = "0x0000000000000000000000000000000000000001";
  assert.throws(() => new CurveService(studio, { chainId: 8453 } as Deployment, "unused", "http://127.0.0.1:8546", address), /local only/);
  assert.throws(() => new CurveService(studio, { chainId: 31337 } as Deployment, "unused", "https://mainnet.base.org", address), /local only/);
});


test("Sepolia profile rejects mainnet and Anvil mutation methods", async () => {
  const studio = new StudioService("unused-sepolia-wallets");
  const admin = new StudioService("unused-sepolia-admin");
  const address = "0x0000000000000000000000000000000000000001";
  assert.throws(() => new CurveService(studio, { chainId: 8453 } as Deployment, "unused", "https://sepolia.base.org", address, undefined, admin), /84532/);
  const curve = new CurveService(studio, { chainId: 84532, launchCurve: address, deployer: address, teamSafe: address, token: address, quoteToken: address, poolManager: address, epochVault: address, tombstoneVault: address }, "unused", "https://sepolia.base.org", address, undefined, admin);
  await assert.rejects(curve.rpc("anvil_setBalance", [address,"0x1"]), /unavailable/);
  await assert.rejects(curve.rpc("evm_revert", ["0x1"]), /unavailable/);
  await assert.rejects(curve.reset(), /cannot rewind/);
  assert.equal(curve.chain.id, 84532);
});


test("dedicated Sepolia fork RPC never falls back to public Sepolia", () => {
  const config = loadConfig({ network: "sepolia", rpcUrl: "http://127.0.0.1:18548", useSequencer: false });
  assert.deepEqual(new RpcManager(config,true).getHttpUrls(), ["http://127.0.0.1:18548/"]);
});
