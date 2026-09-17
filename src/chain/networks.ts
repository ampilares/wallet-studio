import { base, baseSepolia, anvil } from "viem/chains";

// Include viem's OP Stack transaction formatters and serializers.
export { base, base as baseMainnet, baseSepolia };
export type NetworkName = "mainnet" | "sepolia" | "local";
export type NetworkInput = NetworkName | "testnet" | "base" | "base-mainnet" | "base-sepolia";

export function normalizeNetwork(network: string): NetworkName {
  switch (network) {
    case "local": return "local";
    case "mainnet": case "base": case "base-mainnet": return "mainnet";
    case "sepolia": case "testnet": case "base-sepolia": return "sepolia";
    default: throw new Error(`Unsupported Base network: ${network}. Use mainnet or sepolia.`);
  }
}

export function getChain(network: NetworkInput) {
  if (normalizeNetwork(network) === "local") return anvil;
  return normalizeNetwork(network) === "mainnet" ? base : baseSepolia;
}

export function alchemyHttpUrl(network: NetworkInput, apiKey: string): string {
  if (normalizeNetwork(network) === "local") throw new Error("Local networks cannot use Alchemy");
  return `https://base-${normalizeNetwork(network)}.g.alchemy.com/v2/${apiKey}`;
}

export function alchemyWsUrl(network: NetworkInput, apiKey: string): string {
  if (normalizeNetwork(network) === "local") throw new Error("Local networks cannot use Alchemy");
  return `wss://base-${normalizeNetwork(network)}.g.alchemy.com/v2/${apiKey}`;
}

export function sequencerUrl(network: NetworkInput): string {
  if (normalizeNetwork(network) === "local") return "";
  return `https://${normalizeNetwork(network)}-sequencer.base.org`;
}
