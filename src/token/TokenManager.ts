import {
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import type { RpcManager } from "../chain/RpcManager.js";
import type { WalletManager } from "../wallet/WalletManager.js";
import type { NonceManager } from "../wallet/NonceManager.js";
import type { AppConfig } from "../config.js";
import { simpleErc20Abi } from "./SimpleERC20.js";
import { sendDirectTransaction } from "../core/DirectTransactionSender.js";

export class TokenManager {
  constructor(
    private readonly config: AppConfig,
    private readonly rpc: RpcManager,
    private readonly wallets: WalletManager,
    private readonly nonces: NonceManager,
  ) {}

  async deployToken(args: {
    from: Address;
    name: string;
    symbol: string;
    decimals?: number;
    initialSupply: bigint;
  }): Promise<{ simulated: true; deploymentSupported: false; constructorData: Hex }> {
    if (this.config.mode === "live") {
      throw new Error("Live token deployment is disabled: no reviewed compiled artifact is available");
    }
    if (!args.name || !args.symbol || args.initialSupply < 0n) {
      throw new Error("Invalid token deploy parameters");
    }
    const constructorData = encodeAbiParameters(simpleErc20Abi[0].inputs,
      [args.name, args.symbol, args.decimals ?? 18, args.initialSupply, args.from]);
    return { simulated: true, deploymentSupported: false, constructorData };
  }

  async getTokenMetadata(token: Address): Promise<{
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: bigint;
  }> {
    const client = this.rpc.getPublicClient();
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      client.readContract({
        address: token,
        abi: simpleErc20Abi,
        functionName: "name",
      }),
      client.readContract({
        address: token,
        abi: simpleErc20Abi,
        functionName: "symbol",
      }),
      client.readContract({
        address: token,
        abi: simpleErc20Abi,
        functionName: "decimals",
      }),
      client.readContract({
        address: token,
        abi: simpleErc20Abi,
        functionName: "totalSupply",
      }),
    ]);
    return { name, symbol, decimals, totalSupply };
  }

  buildTransferCalldata(to: Address, amount: bigint): Hex {
    return encodeFunctionData({
      abi: simpleErc20Abi,
      functionName: "transfer",
      args: [to, amount],
    });
  }

  buildApproveCalldata(spender: Address, amount: bigint): Hex {
    return encodeFunctionData({
      abi: simpleErc20Abi,
      functionName: "approve",
      args: [spender, amount],
    });
  }

  async transfer(from: Address, token: Address, to: Address, amount: bigint) {
    return this.sendTokenTx(from, token, this.buildTransferCalldata(to, amount));
  }

  async approve(from: Address, token: Address, spender: Address, amount: bigint) {
    return this.sendTokenTx(from, token, this.buildApproveCalldata(spender, amount));
  }

  async mint(from: Address, token: Address, to: Address, amount: bigint) {
    const data = encodeFunctionData({
      abi: simpleErc20Abi,
      functionName: "mint",
      args: [to, amount],
    });
    return this.sendTokenTx(from, token, data);
  }

  async burn(from: Address, token: Address, amount: bigint) {
    const data = encodeFunctionData({
      abi: simpleErc20Abi,
      functionName: "burn",
      args: [amount],
    });
    return this.sendTokenTx(from, token, data);
  }

  private async sendTokenTx(from: Address, token: Address, data: Hex) {
    return sendDirectTransaction(this.config, this.rpc, this.nonces, from, () => this.wallets.getAccount(from), { to: token, data });
  }
}
