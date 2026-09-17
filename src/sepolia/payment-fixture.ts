import { encodeFunctionData, parseAbi, type Address } from "viem";
import { retryDeploymentRead } from "./deployment-errors.js";
import type { SepoliaDeployment } from "./deployment.js";

// Official Uniswap v3 Base Sepolia deployments; independent of the protocol's v4 adapter.
export const paymentInfrastructure = {
  weth: "0x4200000000000000000000000000000000000006",
  swapRouter: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
  quoter: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
  positions: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
} as const;
const wethAbi = parseAbi(["function deposit() payable", "function transfer(address to,uint256 amount) returns (bool)", "function approve(address spender,uint256 amount) returns (bool)"]);
function sqrt(n: bigint): bigint {
  let x=n, y=(x+1n)/2n;
  while(y<x){x=y;y=(x+n/x)/2n;}
  return x;
}
export async function verifyPaymentInfrastructure(d: SepoliaDeployment) {
  for(const address of Object.values(paymentInfrastructure)) {
    const code=await retryDeploymentRead(()=>d.client.getCode({address}));
    if(!code||code==="0x")throw new Error(`Missing Sepolia payment infrastructure: ${address}`);
  }
}
export async function wrapTestETH(d: SepoliaDeployment, amount: bigint, label: string) {
  await d.send(label,encodeFunctionData({abi:wethAbi,functionName:"deposit"}),paymentInfrastructure.weth,amount);
}
export async function fundTestWETH(d: SepoliaDeployment, address: Address) {
  await wrapTestETH(d,200000000000000n,`Wrap WETH for ${address}`);
  await d.send(`Fund WETH ${address}`,encodeFunctionData({abi:wethAbi,functionName:"transfer",args:[address,200000000000000n]}),paymentInfrastructure.weth);
}
export async function seedPaymentLiquidity(d: SepoliaDeployment, quote: Address, usdc: Address, owner: Address) {
  await wrapTestETH(d,5000000000000000n,"Wrap test pool ETH");
  await d.call("MockCbBTC",quote,"faucet",[owner,20000000n],"Mint conversion liquidity");
  await d.call("MockUSDC",usdc,"faucet",[owner,1000000000n],"Mint conversion liquidity");
  for(const [input,amount] of [[paymentInfrastructure.weth,5000000000000000n],[usdc,1000000000n]] as const){
    const sorted=BigInt(input)<BigInt(quote);
    const [token0,token1]=sorted?[input,quote]:[quote,input];
    const [amount0Desired,amount1Desired]=sorted?[amount,10000000n]:[10000000n,amount];
    const price=sqrt((amount1Desired<<192n)/amount0Desired);
    const prefix=`Conversion pool ${input}`;
    await d.call("ITestV3PositionManager",paymentInfrastructure.positions,"createAndInitializePoolIfNecessary",[token0,token1,3000,price],`${prefix} initialize`);
    for(const [address,n] of [[token0,amount0Desired],[token1,amount1Desired]] as const)
      await d.send(`${prefix} approve ${address}`,encodeFunctionData({abi:wethAbi,functionName:"approve",args:[paymentInfrastructure.positions,n]}),address);
    await d.call("ITestV3PositionManager",paymentInfrastructure.positions,"mint",[{token0,token1,fee:3000,tickLower:-887220,tickUpper:887220,amount0Desired,amount1Desired,amount0Min:amount0Desired*99n/100n,amount1Min:amount1Desired*99n/100n,recipient:owner,deadline:(1n<<256n)-1n}],`${prefix} mint`);
    for(const address of [token0,token1])
      await d.send(`${prefix} revoke ${address}`,encodeFunctionData({abi:wethAbi,functionName:"approve",args:[paymentInfrastructure.positions,0n]}),address);
  }
}
