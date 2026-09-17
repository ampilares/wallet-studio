import { isRateLimitError } from "../studio/errors.js";

export function isTransientReadError(error: unknown): boolean {
  if(isRateLimitError(error))return true;
  let current=error;
  for(let i=0;i<6&&current&&typeof current==="object";i++){
    const e=current as {name?:string;code?:unknown;status?:unknown;cause?:unknown};
    if(["TimeoutError","HttpRequestError","SocketClosedError"].includes(e.name??"") && ![400,401,403].includes(Number(e.status)))return true;
    if(["ETIMEDOUT","ECONNRESET","EAI_AGAIN"].includes(String(e.code)))return true;
    current=e.cause;
  }
  return false;
}

/** Only wrap unsigned, read-only operations. Never retry transaction broadcasts here. */
export async function retryDeploymentRead<T>(read:()=>Promise<T>,delayMs=750):Promise<T> {
  for(let attempt=0;;attempt++){
    try{return await read();}
    catch(e){if(attempt>=2||!isTransientReadError(e))throw e;await new Promise(resolve=>setTimeout(resolve,delayMs*(attempt+1)));}
  }
}

export function deploymentFailureMessage(phase:string,error:unknown,hash?:string):string {
  let reason="The provider request failed.";
  if(isRateLimitError(error))reason="The RPC provider rate-limited the request.";
  else if(isTransientReadError(error))reason="The RPC connection timed out or was interrupted.";
  else {
    let current=error;
    for(let i=0;i<6&&current&&typeof current==="object";i++){
      const e=current as {status?:unknown;name?:string;code?:unknown;cause?:unknown;reason?:unknown};
      if(e.status===401||e.status===403)reason="The RPC provider rejected access. Check your Alchemy key and Base Sepolia access.";
      if(e.name==="ContractFunctionRevertedError"||e.name==="ExecutionRevertedError")reason="The contract simulation reverted.";
      if(typeof e.reason==="string" && ["STF","TF","Price slippage check","Transaction too old","LOK","LO","TLU","TLM","TUM"].includes(e.reason))reason=`The contract simulation reverted (${e.reason}).`;
      if(e.code==="ENOENT")reason="A required local deployment file is missing. Rebuild and restart Studio.";
      current=e.cause;
    }
  }
  return `Stopped at ${phase}. ${reason} ${hash?`Saved transaction ${hash}; resume checks that exact hash before continuing.`:"No transaction is recorded for this step; resume the same profile after checking the connection."}`;
}
