import { formatEther, parseEther, type Address } from "viem";
import { assertBundleChain } from "./transactionSafety.js";
import type { AppConfig } from "../config.js";
import type { Bundle, FundingPlan } from "../types.js";
import type { WalletManager } from "../wallet/WalletManager.js";
import type { GasManager } from "../chain/GasManager.js";
import type { BundleRepository } from "../database/repositories.js";
import { safeCliError } from "../security/errors.js";

export type FundingPlanReport = {
  plan: FundingPlan;
  walletsNeedingFunds: Address[];
  alreadyFunded: Address[];
  totalRequiredWei: string;
  totalRequiredEth: string;
  shortfalls: { wallet: Address; amountWei: string }[];
  feeReserveWei: string;
  totalWithFeeReserveWei: string;
  funderBalanceWei?: string;
  funderBalanceEth?: string;
  funderHasEnough?: boolean;
};

/**
 * Builds and optionally executes per-wallet gas/buy funding for a bundle.
 */
export class FundingPlanner {
  constructor(
    private readonly config: AppConfig,
    private readonly wallets: WalletManager,
    private readonly gas: GasManager,
    private readonly bundles: BundleRepository,
  ) {}

  buildPlan(bundle: Bundle, funder?: Address): FundingPlan {
    assertBundleChain(bundle, this.config);
    const minGasWei = parseEther(String(this.config.minGasEth)).toString();
    const perWallet = new Map<string, bigint>();

    for (const action of bundle.actions) {
      const key = action.walletAddress.toLowerCase();
      const value = BigInt(action.valueWei ?? "0");
      perWallet.set(key, (perWallet.get(key) ?? 0n) + value);
    }

    let maxNeed = parseEther(String(this.config.minGasEth));
    for (const value of perWallet.values()) {
      const need = value + parseEther(String(this.config.minGasEth));
      if (need > maxNeed) maxNeed = need;
    }

    return {
      funderAddress: funder ?? bundle.fundingPlan?.funderAddress,
      perWalletWei: maxNeed.toString(),
      minGasWei,
    };
  }

  async analyze(bundle: Bundle, funder?: Address): Promise<FundingPlanReport> {
    const plan = this.buildPlan(bundle, funder);
    const target = BigInt(plan.perWalletWei);
    const needing: Address[] = [];
    const funded: Address[] = [];
    const shortfalls: FundingPlanReport["shortfalls"] = [];
    const seen = new Set<string>();

    for (const wallet of bundle.wallets) {
      const key = wallet.toLowerCase();
      if (seen.has(key) || key === plan.funderAddress?.toLowerCase()) continue;
      seen.add(key);
      const bal = await this.wallets.getBalance(wallet);
      if (bal >= target) funded.push(wallet);
      else { needing.push(wallet); shortfalls.push({ wallet, amountWei: (target - bal).toString() }); }
    }

    const totalRequired = shortfalls.reduce((sum, line) => sum + BigInt(line.amountWei), 0n);
    let feeReserve = 0n;
    if (plan.funderAddress && shortfalls.length) {
      const fees = await this.gas.getGasPrice();
      for (const line of shortfalls) {
        const gas = await this.gas.estimateWalletGas(line.wallet, "0x", BigInt(line.amountWei), plan.funderAddress);
        feeReserve += this.gas.applyBuffer(gas, bundle.gasPlan) * fees.maxFeePerGas;
      }
      // An additional batch reserve, not a protocol-level cap on Base L1 fees.
      feeReserve += BigInt(plan.minGasWei);
    }
    const report: FundingPlanReport = {
      plan,
      walletsNeedingFunds: needing,
      alreadyFunded: funded,
      totalRequiredWei: totalRequired.toString(),
      totalRequiredEth: formatEther(totalRequired),
      shortfalls, feeReserveWei: feeReserve.toString(), totalWithFeeReserveWei: (totalRequired + feeReserve).toString(),
    };

    if (plan.funderAddress) {
      const funderBal = await this.wallets.getBalance(plan.funderAddress);
      report.funderBalanceWei = funderBal.toString();
      report.funderBalanceEth = formatEther(funderBal);
      report.funderHasEnough = funderBal >= totalRequired + feeReserve;
    }

    return report;
  }

  async attachPlan(bundleId: string, funder?: Address): Promise<Bundle> {
    const bundle = await this.bundles.get(bundleId);
    if (!bundle) throw new Error(`Bundle not found: ${bundleId}`);
    bundle.fundingPlan = this.buildPlan(bundle, funder);
    bundle.updatedAt = new Date().toISOString();
    await this.bundles.save(bundle);
    return bundle;
  }

  async executePlan(bundleId: string): Promise<{
    report: FundingPlanReport;
    results: { to: Address; ok: boolean; error?: string; hash?: string }[];
  }> {
    const bundle = await this.bundles.get(bundleId);
    if (!bundle) throw new Error(`Bundle not found: ${bundleId}`);
    if (this.config.mode === "live" && bundle.mode !== "live") {
      throw new Error("Cannot send live funding for a simulation bundle");
    }
    const report = await this.analyze(bundle, bundle.fundingPlan?.funderAddress);
    if (!report.plan.funderAddress) {
      throw new Error("Funding plan has no funderAddress");
    }
    if (report.walletsNeedingFunds.length === 0) {
      return { report, results: [] };
    }

    if (!report.funderHasEnough) throw new Error("Funder needs enough ETH for shortfalls and the transfer fee reserve");
    const results: { to: Address; ok: boolean; error?: string; hash?: string }[] = [];
    for (const line of report.shortfalls) {
      try {
        const current = await this.wallets.getBalance(line.wallet);
        const amount = BigInt(report.plan.perWalletWei) - current;
        if (amount <= 0n) continue;
        if (amount > BigInt(line.amountWei)) throw new Error("Recipient balance changed. Review the funding plan again.");
        const result = await this.wallets.fundWallet(report.plan.funderAddress, line.wallet, formatEther(amount));
        results.push({ to: line.wallet, ok: true, hash: result.hash });
      } catch (error) {
        results.push({ to: line.wallet, ok: false, error: safeCliError(error) });
        break; // An ambiguous transfer stops the batch until reconciliation.
      }
    }
    return { report, results };
  }
}
