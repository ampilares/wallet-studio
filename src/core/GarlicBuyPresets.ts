import { encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address } from "viem";
import type { AppConfig } from "../config.js";
import type { RpcManager } from "../chain/RpcManager.js";
import type { BundleBuilder } from "./BundleBuilder.js";

const curveAbi = parseAbi([
  "function factory() view returns (address)",
  "function quote() view returns (address)",
  "function Smax() view returns (uint256)",
  "function saleAllocation() view returns (uint256)",
  "function sold() view returns (uint256)",
  "function tradePaused() view returns (bool)",
  "function graduated() view returns (bool)",
  "function quoteBuy(uint256 budget) view returns (uint256 tokens,uint256 debit,uint256 charge)",
  "function buyNative(uint256 minTokens,uint256 deadline) payable returns (uint256 tokens)",
]);

const factoryAbi = parseAbi(["function isCurve(address curve) view returns (bool)"]);
const adapterAbi = parseAbi([
  "function factory() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function enabled() view returns (bool)",
  "function buy((uint256 chainId,address deployment,address paymentAsset,uint256 amountIn,address curve,bool graduated,uint24 routeFee,uint256 minQuote,uint256 minTokens,address recipient,address refundRecipient,uint256 deadline) p) payable returns ((uint256 paymentSpent,uint256 quoteReceived,uint256 quoteSpent,uint256 tokens,uint256 paymentRefund,uint256 quoteRefund))",
]);

export type NativeBuyPreset = {
  bundleId: string;
  wallet: Address;
  curve: Address;
  spendWei: bigint;
  walletSpendCeilingWei: bigint;
  minTokens: bigint;
  deadline: number;
};

export type AdapterBuyPreset = NativeBuyPreset & {
  adapter?: Address;
  minQuote: bigint;
  routeFee: number;
  graduated?: boolean;
};

type CurveCaps = { factory: Address; quote: Address; sale: bigint; sold: bigint; remaining: bigint; paused: boolean };

export class GarlicBuyPresets {
  constructor(private readonly config: AppConfig, private readonly rpc: RpcManager,
    private readonly bundles: BundleBuilder) {}

  async addBuyNative(input: NativeBuyPreset) {
    this.assertInputs(input);
    const caps = await this.readCurveCaps(input.curve);
    if (caps.paused) throw new Error("Garlic curve trading is paused");
    if (this.config.network === "mainnet" && caps.quote.toLowerCase() !== this.config.wethAddress!.toLowerCase()) {
      throw new Error("Garlic native buy curve quote is not canonical Base WETH");
    }
    const [tokens, debit] = await this.rpc.getPublicClient().readContract({
      address: input.curve, abi: curveAbi, functionName: "quoteBuy", args: [input.spendWei],
    });
    if (tokens <= 0n || debit <= 0n || input.minTokens <= 0n || input.minTokens > tokens) {
      throw new Error("Garlic buyNative quote is empty or minTokens exceeds the chain quote");
    }
    if (tokens > caps.remaining) throw new Error("Garlic factory allocation cap would be exceeded");
    await this.assertWalletCeiling(input.bundleId, input.wallet, input.spendWei, input.walletSpendCeilingWei);
    const calldata = encodeFunctionData({ abi: curveAbi, functionName: "buyNative", args: [input.minTokens, BigInt(input.deadline)] });
    return this.bundles.addAction(input.bundleId, {
      type: "CONTRACT_CALL", walletAddress: input.wallet, target: input.curve,
      valueWei: input.spendWei.toString(), calldata,
      params: this.params("buyNative", input, caps, tokens),
    });
  }

  async addAdapterBuy(input: AdapterBuyPreset) {
    this.assertInputs(input);
    if (input.minQuote <= 0n || !Number.isSafeInteger(input.routeFee) || input.routeFee < 0 || input.routeFee >= 1_000_000) {
      throw new Error("Garlic adapter purchase requires bounded minQuote and a valid route fee");
    }
    const adapter = getAddress(input.adapter ?? this.config.garlicBuyAdapterAddress ?? zeroAddress);
    if (adapter === zeroAddress) throw new Error("GARLIC_BUY_ADAPTER_ADDRESS is required");
    const caps = await this.readCurveCaps(input.curve);
    const client = this.rpc.getPublicClient();
    const [adapterFactory, wrappedNative, enabled, knownCurve, graduated] = await Promise.all([
      client.readContract({ address: adapter, abi: adapterAbi, functionName: "factory" }),
      client.readContract({ address: adapter, abi: adapterAbi, functionName: "wrappedNative" }),
      client.readContract({ address: adapter, abi: adapterAbi, functionName: "enabled" }),
      client.readContract({ address: caps.factory, abi: factoryAbi, functionName: "isCurve", args: [input.curve] }),
      client.readContract({ address: input.curve, abi: curveAbi, functionName: "graduated" }),
    ]);
    if (adapterFactory.toLowerCase() !== caps.factory.toLowerCase() || !knownCurve) {
      throw new Error("Garlic adapter, factory and curve deployment do not match");
    }
    if (this.config.network === "mainnet" && wrappedNative.toLowerCase() !== this.config.wethAddress!.toLowerCase()) {
      throw new Error("Garlic adapter wrapped native asset is not canonical Base WETH");
    }
    const direct = wrappedNative.toLowerCase() === caps.quote.toLowerCase();
    if ((direct && input.routeFee !== 0) || (!direct && input.routeFee === 0)) {
      throw new Error("Garlic adapter route fee does not match the on-chain payment route");
    }
    if (!enabled || caps.paused) throw new Error("Garlic adapter or curve trading is disabled");
    if (graduated !== (input.graduated ?? false)) throw new Error("Garlic curve graduation state changed");
    if (!graduated && input.minTokens > caps.remaining) throw new Error("Garlic factory allocation cap would be exceeded");
    await this.assertWalletCeiling(input.bundleId, input.wallet, input.spendWei, input.walletSpendCeilingWei);
    const purchase = {
      chainId: BigInt(this.rpc.chain.id), deployment: adapter, paymentAsset: zeroAddress,
      amountIn: input.spendWei, curve: input.curve, graduated,
      routeFee: input.routeFee, minQuote: input.minQuote, minTokens: input.minTokens,
      recipient: input.wallet, refundRecipient: input.wallet, deadline: BigInt(input.deadline),
    };
    const calldata = encodeFunctionData({ abi: adapterAbi, functionName: "buy", args: [purchase] });
    return this.bundles.addAction(input.bundleId, {
      type: "CONTRACT_CALL", walletAddress: input.wallet, target: adapter,
      valueWei: input.spendWei.toString(), calldata,
      params: this.params("buyAdapter", input, caps, input.minTokens, !graduated),
    });
  }

  private assertInputs(input: NativeBuyPreset): void {
    if (input.spendWei <= 0n || input.walletSpendCeilingWei <= 0n) throw new Error("Garlic buy requires positive spend and wallet ceiling");
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(input.deadline) || input.deadline <= now || input.deadline > now + 30 * 60) {
      throw new Error("Garlic buy deadline must be within the next 30 minutes");
    }
    if (input.minTokens <= 0n) throw new Error("Garlic buy requires a non-zero minTokens bound");
  }

  private async readCurveCaps(curve: Address): Promise<CurveCaps> {
    const client = this.rpc.getPublicClient();
    const [factory, quote, cap, sale, sold, paused] = await Promise.all([
      client.readContract({ address: curve, abi: curveAbi, functionName: "factory" }),
      client.readContract({ address: curve, abi: curveAbi, functionName: "quote" }),
      client.readContract({ address: curve, abi: curveAbi, functionName: "Smax" }),
      client.readContract({ address: curve, abi: curveAbi, functionName: "saleAllocation" }),
      client.readContract({ address: curve, abi: curveAbi, functionName: "sold" }),
      client.readContract({ address: curve, abi: curveAbi, functionName: "tradePaused" }),
    ]);
    if (factory === zeroAddress || sale <= 0n || sale > cap || sold > sale) throw new Error("Invalid Garlic factory allocation caps");
    if (this.config.network === "mainnet" && !this.config.garlicFactoryAddress) {
      throw new Error("GARLIC_FACTORY_ADDRESS is required for mainnet Garlic presets");
    }
    if (this.config.garlicFactoryAddress && factory.toLowerCase() !== this.config.garlicFactoryAddress.toLowerCase()) {
      throw new Error("Garlic curve factory does not match GARLIC_FACTORY_ADDRESS");
    }
    const known = await client.readContract({ address: factory, abi: factoryAbi, functionName: "isCurve", args: [curve] });
    if (!known) throw new Error("Garlic factory does not recognize the curve");
    return { factory, quote, sale, sold, remaining: sale - sold, paused };
  }

  private async assertWalletCeiling(bundleId: string, wallet: Address, spend: bigint, ceiling: bigint): Promise<void> {
    const bundle = await this.bundles.get(bundleId);
    if (!bundle) throw new Error(`Bundle not found: ${bundleId}`);
    const planned = bundle.actions.filter((a) => a.walletAddress.toLowerCase() === wallet.toLowerCase() &&
      (a.params?.garlicPreset === "buyNative" || a.params?.garlicPreset === "buyAdapter"))
      .reduce((sum, a) => sum + BigInt(a.valueWei ?? "0"), 0n);
    const existingCeilings = bundle.actions.filter((a) => a.walletAddress.toLowerCase() === wallet.toLowerCase() &&
      (a.params?.garlicPreset === "buyNative" || a.params?.garlicPreset === "buyAdapter"))
      .map((a) => BigInt(String(a.params?.walletSpendCeilingWei ?? "0")));
    if (existingCeilings.some((existing) => existing !== ceiling)) {
      throw new Error(`Garlic wallet spend ceiling is inconsistent for ${wallet}`);
    }
    if (planned + spend > ceiling) throw new Error(`Garlic wallet spend ceiling exceeded for ${wallet}`);
  }

  private params(kind: "buyNative" | "buyAdapter", input: NativeBuyPreset, caps: CurveCaps, quotedTokens: bigint,
    factoryCapApplies = true) {
    return {
      garlicPreset: kind, curve: input.curve, amountIn: input.spendWei.toString(),
      walletSpendCeilingWei: input.walletSpendCeilingWei.toString(), quotedTokens: quotedTokens.toString(),
      factory: caps.factory, factoryCap: caps.sale.toString(), factorySoldBefore: caps.sold.toString(),
      factoryRemainingTokens: caps.remaining.toString(), factoryCapApplies,
      minTokens: input.minTokens.toString(), deadline: input.deadline,
    };
  }
}
