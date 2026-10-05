import { getAddress, isAddress, parseEther } from "viem";
import { Bundler } from "../src/index.js";

// Use Base Sepolia deployment addresses for rehearsal. Mainnet startup accepts
// only the canonical Base WETH/router pair and live sends additionally require
// MAINNET_SEND_ENABLED=true plus a fresh simulation of the exact bundle.
const studio = Bundler.create({ network: "sepolia", mode: "live" });
await studio.assertRuntime();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Sepolia rehearsal`);
  return value;
}

function requiredAddress(name: string) {
  const value = required(name);
  if (!isAddress(value, { strict: false })) throw new Error(`${name} must be an EVM address`);
  return getAddress(value);
}

const wallet = requiredAddress("GARLIC_WALLET_ADDRESS");
const curve = requiredAddress("GARLIC_CURVE_ADDRESS");
const spendWei = parseEther(required("GARLIC_SPEND_ETH"));
const walletSpendCeilingWei = parseEther(required("GARLIC_WALLET_SPEND_CEILING_ETH"));
const minTokens = BigInt(required("GARLIC_MIN_TOKENS"));
if (minTokens <= 0n || process.env.GARLIC_QUOTE_REVIEWED !== "true") {
  throw new Error("Set a reviewed non-zero GARLIC_MIN_TOKENS and GARLIC_QUOTE_REVIEWED=true");
}
const bundle = await studio.bundles.createBundle("Garlic guarded buy");

await studio.garlic.addBuyNative({
  bundleId: bundle.id,
  wallet,
  curve,
  spendWei,
  walletSpendCeilingWei,
  minTokens,
  deadline: Math.floor(Date.now() / 1000) + 10 * 60,
});

await studio.bundles.validateBundle(bundle.id);
const exact = await studio.bundles.get(bundle.id);
if (!exact) throw new Error("Bundle disappeared");
console.log(await studio.simulator.simulateBundle(exact));

if (process.env.EXECUTE_SEPOLIA_REHEARSAL === "true") {
  console.log(await studio.executor.executeBundle(bundle.id));
} else {
  console.log("Dry run complete. Set EXECUTE_SEPOLIA_REHEARSAL=true to submit this Base Sepolia rehearsal.");
}
