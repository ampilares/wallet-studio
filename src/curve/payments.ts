import { encodePacked, parseAbi, parseUnits, formatUnits, zeroAddress, type Address, type Hex } from "viem";
import { randomUUID } from "node:crypto";
import { StudioError } from "../studio/service.js";
import type { CurveService } from "./service.js";
import type { CurveRequest, CurvePreview } from "./types.js";
export const purchaseAbi = parseAbi([
  "function quotePayment(address payment,uint256 amount,bytes path) returns (uint256,uint256,uint256,bool)",
  "function buy(address payment,uint256 amount,bytes path,uint256 minQuote,uint256 minTokens,uint256 deadline,bool expectedGraduated) payable returns (uint256)",
]);
export type RoutedPayment = { payment: Address; path: Hex; minQuote: bigint; deadline: bigint; graduated: boolean };
export async function previewPayment(service: CurveService,input: CurveRequest,selected: string[]) {
  const d=service.deployment;
  if(!service.sepoliaAdmin||!d.purchaseRouter||!d.paymentWETH||!d.paymentUSDC||input.operation!=="buy")throw new StudioError("Payment conversion requires a fresh Sepolia deployment with seeded test pools.");
  const decimals=input.payment==="USDC"?6:18;
  if(!new RegExp(`^[0-9]+(\\.[0-9]{1,${decimals}})?$`).test(input.amount))throw new StudioError(`Use at most ${decimals} decimals for ${input.payment}.`);
  const amount=parseUnits(input.amount,decimals);
  if(amount<=0n)throw new StudioError("Amount must be positive.");
  const payment=input.payment==="ETH"?zeroAddress:(input.payment==="WETH"?d.paymentWETH:d.paymentUSDC) as Address;
  const path=encodePacked(["address","uint24","address"],[payment===zeroAddress?d.paymentWETH as Address:payment,3000,d.quoteToken]);
  const block=await service.client.getBlock();
  const {result}=await service.client.simulateContract({address:d.purchaseRouter as Address,abi:purchaseAbi,functionName:"quotePayment",args:[payment,amount,path],blockNumber:block.number});
  const minQuote=result[0]*99n/100n,minimum=result[1]*(input.tight?9999n:9900n)/10000n;
  if(!minQuote||!minimum)throw new StudioError("Amount is too small.");
  const end=await service.read<bigint>(d.launchCurve,"guardEndBlock");
  const cap=await service.read<bigint>(d.launchCurve,"walletGuardCap");
  const guardBlocks=await service.read<number>(d.launchCurve,"guardBlocks");
  for(const wallet of selected){
    const eth=await service.client.getBalance({address:wallet as Address});
    if(eth<(payment===zeroAddress?amount:0n)+300000000000000n)throw new StudioError("A selected wallet needs more ETH for input and gas.");
    if(payment!==zeroAddress&&await service.read<bigint>(payment,"balanceOf",[wallet])<amount)throw new StudioError(`A selected wallet needs more ${input.payment}.`);
    if(!result[3]&&guardBlocks>0&&(end===0n||block.number<end)&&await service.read<bigint>(d.launchCurve,"guardPurchased",[wallet])+result[1]>cap)throw new StudioError("This purchase exceeds a selected wallet's remaining cap.");
  }
  const fees=await service.client.estimateFeesPerGas();
  const view:CurvePreview={id:randomUUID(),expiresAt:Date.now()+60000,operation:"buy",venue:`${input.payment} → test cbBTC (v3 0.3%) → ${result[3]?"Uniswap v4":"curve"}`,amount:input.amount,total:formatUnits(amount*BigInt(selected.length),decimals),payment:input.payment,maximumGasEth:formatUnits(2000000n*BigInt(selected.length)*(fees.maxFeePerGas??0n),18),rows:selected.map(address=>({address,expected:formatUnits(result[1],8),minimum:formatUnits(minimum,8)}))};
  const route:RoutedPayment={payment,path,minQuote,deadline:block.timestamp+120n,graduated:result[3]};
  return {view,route,amount,minimum};
}
