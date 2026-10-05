import { encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address } from "viem";
import type { MintCampaignInput } from "./types.js";

// Collection configuration verified against Base on 2026-09-19. Read again at
// preflight and immediately before each signature; never follow a changed price.
export const GENESIS = {
  collection: getAddress("0xe7503b685ead99128d5f145d502fc928281c182c"),
  seaDrop: getAddress("0x00005ea00ac477b1030ce78506496e8c2de24bf5"),
  feeRecipient: getAddress("0x0000a26b00c1f0df003000390027140000faa719"),
  startTime: 1789835040,
  endTime: 1791044640,
  signature: "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
} as const;

export const seaDropAbi = parseAbi([
  GENESIS.signature,
  "function getPublicDrop(address) view returns ((uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address) view returns (address[])",
]);
export const collectionAbi = parseAbi([
  "function getMintStats(address) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
  "function ownerOf(uint256) view returns (address)",
]);

export function genesisInput(wallets: Address[], network: MintCampaignInput["network"] = "mainnet"): MintCampaignInput {
  return {
    adapter: "btc-genesis-seadrop", name: "BTC Genesis Miners", network,
    contract: GENESIS.collection, standard: "ERC721", functionSignature: GENESIS.signature,
    functionName: "mintPublic", arguments: [
      { kind: "literal", value: GENESIS.collection }, { kind: "literal", value: GENESIS.feeRecipient },
      { kind: "literal", value: zeroAddress }, { kind: "quantity" },
    ], wallets, quantity: 1, pricePerTokenWei: "0", feeBufferWei: "10000000000000",
    maxFeePerWalletWei: "100000000000000", spendCeilingWei: (100000000000000n * BigInt(wallets.length)).toString(),
    confirmations: 2, concurrency: 2, mainnetApproved: false,
  };
}

export function genesisCalldata() {
  return encodeFunctionData({ abi: seaDropAbi, functionName: "mintPublic", args: [GENESIS.collection, GENESIS.feeRecipient, zeroAddress, 1n] });
}

export function mintTarget(input: MintCampaignInput): Address {
  return input.adapter === "btc-genesis-seadrop" ? GENESIS.seaDrop : input.contract;
}
