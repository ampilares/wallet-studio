/** Classify a provider error without exposing its URL, payload or credentials. */
export function isRateLimitError(error: unknown): boolean {
  let current=error;
  for(let i=0;i<6 && current && typeof current==="object";i++) {
    const value=current as {code?:unknown;status?:unknown;message?:unknown;cause?:unknown};
    if(value.status===429 || (typeof value.message==="string" && /over rate limit|rate.limit|too many requests/i.test(value.message)))return true;
    current=value.cause;
  }
  return false;
}
