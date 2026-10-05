import { useEffect, useState } from "react";
import { formatEther } from "viem";
import type { FundingBatch } from "../src/studio/fundingTypes.js";
import type { StudioState } from "../src/studio/types.js";
import { api } from "./api.js";
import { Field, FormError, Modal, short } from "./components.js";

export function MainnetFundingDialog({ state, selected, focused, onClose, onDone }: { state: StudioState; selected: string[]; focused: string; onClose: () => void; onDone: (message: string) => void }) {
  const [from, setFrom] = useState(focused || state.wallets[0]?.address || "");
  const [amount, setAmount] = useState("");
  const [feeCap, setFeeCap] = useState("0.00001");
  const [batches, setBatches] = useState<FundingBatch[]>([]);
  const [batch, setBatch] = useState<FundingBatch>();
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const wallets = (selected.length ? selected : state.wallets.map(wallet => wallet.address)).filter(wallet => wallet.toLowerCase() !== from.toLowerCase());
  useEffect(() => { void api<FundingBatch[]>("funding/batches").then(rows => { setBatches(rows); setBatch(rows.find(row => row.status !== "completed" && row.lines.some(line => line.hash))); }).catch(error => setError(error.message)); }, []);
  useEffect(() => {
    if (!batch) return;
    const timer = setInterval(() => { void api<FundingBatch[]>("funding/batches").then(rows => { setBatches(rows); setBatch(current => rows.find(row => row.id === current?.id) ?? current); }).catch(() => undefined); }, 2500);
    return () => clearInterval(timer);
  }, [batch?.id]);
  async function perform(route: string, input: unknown) {
    setBusy(true); setError("");
    try { const result = await api<FundingBatch>(`funding/${route}`, input); setBatch(result); setApproved(false); if (route === "start") onDone("Mainnet funding batch started. Reopen Distribute ETH to follow its saved progress."); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  const eth = (value: string) => formatEther(BigInt(value));
  const remaining = batch?.lines.filter(line => !line.hash).length ?? 0;
  return <Modal title="Distribute Base mainnet ETH" onClose={onClose} busy={busy}>
    <p className="mb-4 text-sm text-muted">Real ETH on Base · chain 8453. One approval starts separate transfers, not a single atomic transaction. Only other wallets in this vault can receive funds.</p>
    <FormError message={error || batch?.error || ""} />
    {batch ? <div className="grid gap-4">
      <p className="text-sm"><strong>{batch.lines.filter(line => line.status === "confirmed").length}/{batch.lines.length} confirmed</strong> · {batch.status} · {remaining} unsent</p>
      <p className="break-all font-mono text-xs">Funding wallet: {batch.from}</p>
      <div className="max-h-64 overflow-y-auto rounded-xl border border-line">{batch.lines.map(line => <div key={line.to} className="border-b border-line p-3 text-xs"><p className="break-all font-mono">{line.to}</p><p className="mt-1">{eth(line.amountWei)} ETH · {line.status}{line.actualFeeWei && ` · fee ${eth(line.actualFeeWei)} ETH`}</p>{line.hash && <a className="text-accent underline" href={`https://basescan.org/tx/${line.hash}`} target="_blank" rel="noreferrer">{short(line.hash)}</a>}</div>)}</div>
      <dl className="grid grid-cols-2 gap-2 text-sm"><dt>Total recipient funding</dt><dd className="text-right font-mono">{eth(batch.totalWei)} ETH</dd><dt>Total fee allowance</dt><dd className="text-right font-mono">{eth(batch.feeAllowanceWei)} ETH</dd><dt>Total batch allowance</dt><dd className="text-right font-mono">{eth(batch.requiredWei)} ETH</dd></dl>
      <p className="text-xs text-muted">Totals cover the original batch. Resuming skips every recorded confirmed/reverted transaction. Base L1 fees can change after signing and cannot be absolutely capped. Each transfer waits for two confirmations.</p>
      {batch.status !== "completed" && <>
        <p className="text-xs text-muted">Review {Date.now() > batch.expiresAt ? "expired—refresh before sending unsent transfers" : `expires at ${new Date(batch.expiresAt).toLocaleTimeString()}`}. MAINNET_SEND_ENABLED=true is required on the server.</p>
        <label className="flex items-start gap-2 text-sm"><input className="checkbox mt-1" type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} /><span>I approve these recipients, ETH amounts and fee allowances on Base mainnet.</span></label>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy || !approved || (remaining > 0 && Date.now() > batch.expiresAt)} onClick={() => void perform("start", { id: batch.id, mainnetApproved: true })}>{batch.status === "running" ? "Recover after server restart" : "Confirm / resume funding"}</button>
          {batch.status === "running" ? <button className="btn-secondary" disabled={busy} onClick={() => void perform("stop", { id: batch.id })}>Stop new transfers</button> : <><button className="btn-secondary" disabled={busy} onClick={() => void perform("reconcile", { id: batch.id })}>Reconcile receipts</button>{remaining > 0 && <button className="btn-secondary" disabled={busy} onClick={() => void perform("review", { id: batch.id })}>Refresh remaining review</button>}</>}
        </div>
      </>}
      <button className="btn-secondary" disabled={busy} onClick={() => { setBatch(undefined); setApproved(false); setError(""); }}>Back to funding setup</button>
    </div> : <form className="mt-4 grid gap-4" onSubmit={event => { event.preventDefault(); void perform("preview", { from, wallets, amount, maxFeePerTransfer: feeCap }); }}>
      {batches.length > 0 && <section className="grid gap-2"><p className="text-sm font-semibold">Saved funding batches</p>{batches.map(row => <button key={row.id} type="button" className="btn-secondary" onClick={() => { setBatch(row); setApproved(false); }}>{new Date(row.createdAt).toLocaleString()} · {row.lines.filter(line => line.status === "confirmed").length}/{row.lines.length} · {row.status}</button>)}</section>}
      <Field label="Funding wallet" hint="Fund this address with Base ETH first. Its existing balance also remains available for its own NFT mint."><select value={from} onChange={event => setFrom(event.target.value)}>{state.wallets.map(wallet => <option key={wallet.address} value={wallet.address}>{wallet.label} · {short(wallet.address)}</option>)}</select></Field>
      <p className="break-all font-mono text-xs">{from}</p>
      <p className="text-sm"><strong>{wallets.length} recipients</strong>; the funding wallet is excluded. Select recipients on the Wallets page, or leave the selection empty to use all other vault wallets.</p>
      <Field label="ETH per recipient"><input required inputMode="decimal" placeholder="Enter the amount for each wallet" value={amount} onChange={event => setAmount(event.target.value)} /></Field>
      <Field label="Fee allowance per transfer (ETH)" hint="This is an allowance, not a fee quote. Review estimates L2 gas, L1 data and operator fees plus a buffer."><input required inputMode="decimal" value={feeCap} onChange={event => setFeeCap(event.target.value)} /></Field>
      <button className="btn-primary" disabled={busy || !wallets.length}>{busy ? "Checking balances and fees…" : `Review ${wallets.length} transfers`}</button>
      <p className="text-xs text-muted">Review sends nothing. Keep enough ETH in the funding wallet for its own mint. After a timeout or restart, use the saved batch instead of creating another payment to the same recipients.</p>
    </form>}
  </Modal>;
}
