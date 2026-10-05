import "dotenv/config";
import { z } from "zod";
import { normalizeNetwork, type NetworkName, type NetworkInput } from "./chain/networks.js";
import { getAddress, isAddress, type Address } from "viem";

export const BASE_MAINNET_WETH = getAddress("0x4200000000000000000000000000000000000006");
export const BASE_MAINNET_UNISWAP_V2_ROUTER = getAddress("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24");

const envSchema = z.object({
  BUNDLER_NETWORK: z.enum(["mainnet", "sepolia", "testnet", "base", "base-mainnet", "base-sepolia", "local"]).default("sepolia"),
  BUNDLER_MODE: z.enum(["simulation", "live"]).default("simulation"),
  RPC_URL: z.string().optional().default(""),
  RPC_URL_SECONDARY: z.string().optional().default(""),
  WS_URL: z.string().optional().default(""),
  ALCHEMY_API_KEY: z.string().optional().default(""),
  WALLET_PASSPHRASE: z.string().default(""),
  MAX_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MIN_GAS_ETH: z.coerce.number().positive().default(0.002),
  DEFAULT_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(9999).default(100),
  DATA_DIR: z.string().default(""),
  USE_SEQUENCER: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  SEQUENCER_URL: z.string().optional().default(""),
  WETH_ADDRESS: z.string().optional().default(""),
  DEX_ROUTER_ADDRESS: z.string().optional().default(""),
  GARLIC_FACTORY_ADDRESS: z.string().optional().default(""),
  GARLIC_BUY_ADAPTER_ADDRESS: z.string().optional().default(""),
  MAINNET_SEND_ENABLED: z.enum(["true", "false", "1", "0"]).optional().default("false")
    .transform((v) => v === "true" || v === "1"),
});

export type AppConfig = {
  network: NetworkName;
  mode: "simulation" | "live";
  rpcUrl: string;
  rpcUrlSecondary: string;
  wsUrl: string;
  alchemyApiKey: string;
  walletPassphrase: string;
  maxConcurrency: number;
  minGasEth: number;
  defaultSlippageBps: number;
  dataDir: string;
  useSequencer: boolean;
  sequencerUrl: string;
  wethAddress?: Address;
  dexRouterAddress?: Address;
  garlicFactoryAddress?: Address;
  garlicBuyAdapterAddress?: Address;
  mainnetSendEnabled?: boolean;
};

export type ConfigOverrides = Omit<Partial<AppConfig>, "network"> & { network?: NetworkInput };

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const parsed = envSchema.parse(process.env);
  const base: AppConfig = {
    network: normalizeNetwork(parsed.BUNDLER_NETWORK),
    mode: parsed.BUNDLER_MODE,
    rpcUrl: parsed.RPC_URL,
    rpcUrlSecondary: parsed.RPC_URL_SECONDARY,
    wsUrl: parsed.WS_URL,
    alchemyApiKey: parsed.ALCHEMY_API_KEY,
    walletPassphrase: parsed.WALLET_PASSPHRASE,
    maxConcurrency: parsed.MAX_CONCURRENCY,
    minGasEth: parsed.MIN_GAS_ETH,
    defaultSlippageBps: parsed.DEFAULT_SLIPPAGE_BPS,
    dataDir: parsed.DATA_DIR,
    useSequencer: parsed.USE_SEQUENCER,
    sequencerUrl: parsed.SEQUENCER_URL,
    wethAddress: parsed.WETH_ADDRESS ? requireAddress("WETH_ADDRESS", parsed.WETH_ADDRESS) : undefined,
    dexRouterAddress: parsed.DEX_ROUTER_ADDRESS ? requireAddress("DEX_ROUTER_ADDRESS", parsed.DEX_ROUTER_ADDRESS) : undefined,
    garlicFactoryAddress: parsed.GARLIC_FACTORY_ADDRESS ? requireAddress("GARLIC_FACTORY_ADDRESS", parsed.GARLIC_FACTORY_ADDRESS) : undefined,
    garlicBuyAdapterAddress: parsed.GARLIC_BUY_ADAPTER_ADDRESS ? requireAddress("GARLIC_BUY_ADAPTER_ADDRESS", parsed.GARLIC_BUY_ADAPTER_ADDRESS) : undefined,
    mainnetSendEnabled: parsed.MAINNET_SEND_ENABLED,
  };
  const network = normalizeNetwork(overrides.network ?? base.network);
  const config = { ...base, ...overrides, network,
    dataDir: overrides.dataDir || parsed.DATA_DIR || `./data/base-${network}` };
  assertCanonicalMainnetConfig(config);
  return config;
}

function requireAddress(name: string, value: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`${name} must be a valid EVM address`);
  return getAddress(value);
}

export function assertCanonicalMainnetConfig(config: AppConfig): void {
  if (config.network !== "mainnet") return;
  if (config.wethAddress?.toLowerCase() !== BASE_MAINNET_WETH.toLowerCase()) {
    throw new Error(`Base mainnet WETH_ADDRESS must be ${BASE_MAINNET_WETH}`);
  }
  if (config.dexRouterAddress?.toLowerCase() !== BASE_MAINNET_UNISWAP_V2_ROUTER.toLowerCase()) {
    throw new Error(`Base mainnet DEX_ROUTER_ADDRESS must be ${BASE_MAINNET_UNISWAP_V2_ROUTER}`);
  }
}
