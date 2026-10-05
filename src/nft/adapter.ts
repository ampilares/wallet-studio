import {
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type { MintArgument, MintCampaignInput, NftStandard } from "./types.js";
import { GENESIS, genesisCalldata } from "./genesis.js";
import { MAX_STUDIO_WALLETS } from "../studio/limits.js";

const eventAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);

export function campaignAbi(input: Pick<MintCampaignInput, "functionSignature">): Abi {
  const signature = input.functionSignature.trim();
  if (!signature.startsWith("function ")) throw new Error("Mint function signature must start with 'function '.");
  return parseAbi([signature]);
}

export function mintArguments(input: MintCampaignInput, wallet: Address): readonly unknown[] {
  const values = input.walletArguments?.[wallet.toLowerCase()] ?? input.walletArguments?.[wallet] ?? {};
  return input.arguments.map((argument: MintArgument) => {
    if (argument.kind === "wallet") return wallet;
    if (argument.kind === "quantity") return BigInt(input.quantity);
    if (argument.kind === "literal") return normalizeLiteral(argument.value);
    if (!(argument.key in values)) throw new Error(`Missing wallet-specific argument '${argument.key}'.`);
    return normalizeLiteral(values[argument.key]);
  });
}

function normalizeLiteral(value: unknown): unknown {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(normalizeLiteral);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeLiteral(item)]));
  return value;
}

export function encodeMint(input: MintCampaignInput, wallet: Address): Hex {
  return encodeFunctionData({ abi: campaignAbi(input), functionName: input.functionName, args: mintArguments(input, wallet) });
}

export function validateCampaignInput(input: MintCampaignInput): void {
  if (!input.name.trim() || input.name.length > 80) throw new Error("Use a campaign name between 1 and 80 characters.");
  if (!isAddress(input.contract) || /^0x0{40}$/i.test(input.contract)) throw new Error("Enter a valid non-zero collection address.");
  input.contract = getAddress(input.contract);
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 100) throw new Error("Quantity must be between 1 and 100.");
  if (!Number.isInteger(input.confirmations) || input.confirmations < 1 || input.confirmations > 64) throw new Error("Confirmations must be between 1 and 64.");
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 10) throw new Error("Concurrency must be between 1 and 10.");
  if (!input.wallets.length || input.wallets.length > MAX_STUDIO_WALLETS) throw new Error(`Select between 1 and ${MAX_STUDIO_WALLETS} wallets.`);
  if (new Set(input.wallets.map(value => value.toLowerCase())).size !== input.wallets.length) throw new Error("Wallet selection contains duplicates.");
  for (const field of ["pricePerTokenWei", "feeBufferWei", "maxFeePerWalletWei", "spendCeilingWei"] as const) {
    if (!/^\d+$/.test(input[field]) || BigInt(input[field]) < 0n) throw new Error(`${field} must be an integer amount in wei.`);
  }
  if (BigInt(input.maxFeePerWalletWei) <= 0n || BigInt(input.spendCeilingWei) <= 0n) throw new Error("Fee and campaign spend ceilings must be greater than zero.");
  const abi = campaignAbi(input);
  for (const wallet of input.wallets) encodeFunctionData({ abi, functionName: input.functionName, args: mintArguments(input, wallet) });
  if (input.adapter === "btc-genesis-seadrop") {
    if (!["mainnet", "local"].includes(input.network) || input.contract !== GENESIS.collection || input.standard !== "ERC721" || input.quantity !== 1 || BigInt(input.pricePerTokenWei) !== 0n || input.wallets.some(wallet => encodeMint(input, wallet) !== genesisCalldata())) {
      throw new Error("BTC Genesis preset requires the pinned collection, free public mint, and exactly one NFT to each paying wallet on Base (or a local fork).");
    }
    if (input.confirmations < 2) throw new Error("The Genesis preset requires at least two confirmations.");
  }
}

export function classifySimulationError(error: unknown): { status: "ineligible" | "sale-inactive" | "sold-out" | "contract-error"; reason: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/\s+/g, " ");
  const lower = message.toLowerCase();
  if (/sold out|max supply|supply exceeded|mintquantityexceedsmaxsupply/.test(lower)) return { status: "sold-out", reason: "Collection supply is exhausted." };
  if (/not active|notactive|sale inactive|not started|paused/.test(lower)) return { status: "sale-inactive", reason: "The sale is not active yet, has ended, or is paused." };
  if (/allowlist|proof|eligible|mint limit|already minted|mintquantityexceedsmaxminted/.test(lower)) return { status: "ineligible", reason: "Wallet is ineligible or has reached its mint limit." };
  // RPC errors can contain API keys, calldata, or raw signed transactions.
  return { status: "contract-error", reason: "Contract simulation or RPC request failed. Check the network, sale settings, and wallet balance." };
}

export function decodeMintReceipt(standard: NftStandard, wallet: Address, receipt: TransactionReceipt, collection: Address): string[] {
  return [...decodeMintAmounts(standard, wallet, receipt, collection).keys()];
}

/** ERC-1155 quantities are event values, not the number of distinct token IDs. */
export function decodeMintAmounts(standard: NftStandard, wallet: Address, receipt: TransactionReceipt, collection: Address): Map<string, bigint> {
  const logs = parseEventLogs({ abi: eventAbi, logs: receipt.logs.filter(log => log.address.toLowerCase() === collection.toLowerCase()), strict: true });
  const recipient = wallet.toLowerCase();
  const amounts = new Map<string, bigint>();
  const add = (id: bigint, value: bigint) => { if (value > 0n) amounts.set(id.toString(), (amounts.get(id.toString()) ?? 0n) + value); };
  for (const log of logs) {
    if (log.args.to.toLowerCase() !== recipient || log.args.from !== "0x0000000000000000000000000000000000000000") continue;
    if (standard === "ERC721" && log.eventName === "Transfer") {
      amounts.set(log.args.tokenId.toString(), 1n);
    }
    if (standard === "ERC1155" && log.eventName === "TransferSingle") {
      add(log.args.id, log.args.value);
    }
    if (standard === "ERC1155" && log.eventName === "TransferBatch") {
      if (log.args.ids.length !== log.args.values.length) throw new Error("Malformed ERC-1155 batch quantities");
      log.args.ids.forEach((id, index) => add(id, log.args.values[index]));
    }
  }
  return amounts;
}
