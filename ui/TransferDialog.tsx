import { useState } from "react";
import { ArrowRight, ArrowUpRight, CheckCircle, ShieldCheck } from "@phosphor-icons/react";
import type { StudioState, TransferInput, TransferPreview } from "../src/studio/types.js";
import { api } from "./api.js";
import { Field, FormError, Modal, short } from "./components.js";

export function TransferDialog({ state, kind, selected, focused, onClose, onDone }: {
  state: StudioState; kind: TransferInput["kind"]; selected: string[]; focused: string;
  onClose: () => void; onDone: (message: string) => void;
}) {
  const [from, setFrom] = useState(focused || state.wallets[0]?.address || "");
  const [to, setTo] = useState(state.wallets.find(w => w.address !== focused)?.address || "");
  const [external, setExternal] = useState(false);
  const [amount, setAmount] = useState("0.1");
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<number | null>(null);
  const title = kind === "send" ? "Send ETH" : kind === "distribute" ? "Distribute ETH" : "Collect ETH";
  const wallets = selected.length ? selected : state.wallets.map(w => w.address);
  const targets = wallets.filter(a => a !== (kind === "distribute" ? from : to));
  const name = (address: string) => state.wallets.find(w => w.address === address)?.label ?? "External wallet";
  async function review() {
    setBusy(true); setError("");
    try { setPreview(await api<TransferPreview>("preview", { network: state.network.key, kind, from, to, wallets: targets, amount })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true); setError("");
    try { const result = await api<{ sent: number }>("execute", { id: preview.id }); setDone(result.sent); onDone(`${result.sent} transfer${result.sent === 1 ? "" : "s"} confirmed.`); }
    catch (e) { setError((e as Error).message); setPreview(null); onDone("Activity updated. Check the latest transaction status."); }
    finally { setBusy(false); }
  }
  return <Modal title={done !== null ? "Transfer complete" : preview ? "Review transfer" : title} onClose={onClose} busy={busy}>
    {done !== null ? <div className="grid justify-items-center gap-5 py-6 text-center"><CheckCircle size={54} className="text-accent" weight="duotone" /><div><h3 className="text-xl font-semibold">{done} transfer{done === 1 ? "" : "s"} confirmed</h3><p className="mt-2 text-sm text-muted">Balances and activity have been updated.</p></div><button className="btn-primary mt-2 w-full" onClick={onClose}>Back to wallets</button></div> : <>
      <div className="mb-6 flex items-center justify-between text-sm"><span className="pill"><span className="status-dot" />{state.network.name}</span><span className="text-muted">Test ETH only</span></div>
      {preview ? <>
        <p className="mb-4 text-sm leading-relaxed text-muted">Check the exact recipients and amounts. This review is valid for one minute.</p>
        <div className="max-h-64 overflow-y-auto rounded-xl border border-line divide-y divide-line">{preview.lines.map((line, i) => <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 p-4 text-sm"><div><p className="font-medium">{name(line.from)}</p><span className="font-mono text-xs text-muted">{short(line.from)}</span></div><ArrowRight size={16} className="text-muted" /><div className="text-right"><p className="font-medium">{name(line.to)}</p><p className="break-all font-mono text-xs text-muted" title={line.to}>{line.to}</p><p className="mt-1 font-mono font-semibold">{line.amount} ETH</p></div></div>)}</div>
        <dl className="my-5 grid grid-cols-2 gap-y-3 text-sm"><dt className="text-muted">Total to send</dt><dd className="text-right font-mono font-semibold">{preview.total} ETH</dd><dt className="text-muted">Maximum L2 execution fees</dt><dd className="text-right font-mono">{preview.maxFees} ETH</dd></dl>
        {state.network.key === "sepolia" && <p className="mb-4 text-xs text-muted">Base Sepolia also charges L1 data fees. A separate test-ETH reserve is required.</p>}
        <FormError message={error} />
        <div className="mt-6 grid grid-cols-[auto_1fr] gap-3"><button className="btn-secondary" disabled={busy} onClick={() => setPreview(null)}>Edit</button><button className="btn-primary" disabled={busy || Date.now() > preview.expiresAt} onClick={confirm}>{busy ? "Confirming transactions…" : `Confirm ${preview.lines.length === 1 ? "transfer" : `${preview.lines.length} transfers`}`}<ArrowUpRight size={17} /></button></div>
      </> : <form className="grid gap-5" onSubmit={event => { event.preventDefault(); void review(); }}>
        {kind !== "collect" && <Field label="From wallet"><select value={from} onChange={e => setFrom(e.target.value)}>{state.wallets.map(w => <option key={w.address} value={w.address}>{w.label} · {short(w.address)}</option>)}</select></Field>}
        {kind !== "distribute" && <div className="grid gap-3"><Field label={kind === "collect" ? "Collect into" : "Recipient"} hint={external ? "Check the full address before continuing." : "Select a wallet from your vault."}>
          {external ? <input value={to} onChange={e => setTo(e.target.value)} placeholder="0x…" required autoComplete="off" /> : <select value={to} onChange={e => setTo(e.target.value)}>{state.wallets.map(w => <option key={w.address} value={w.address}>{w.label} · {short(w.address)}</option>)}</select>}
        </Field><label className="flex items-center gap-2 text-xs font-normal"><input className="checkbox" type="checkbox" checked={external} onChange={e => { setExternal(e.target.checked); setTo(e.target.checked ? "" : state.wallets.find(w => w.address !== from)?.address ?? ""); }} />Use an external address</label></div>}
        {kind !== "send" && <div className="rounded-xl bg-canvas px-4 py-3 text-sm"><strong>{targets.length} wallets</strong> {kind === "collect" ? "will each send this amount." : "will each receive this amount."}<p className="mt-1 text-xs text-muted">{kind === "collect" ? "The destination wallet is excluded." : "The sending wallet is excluded."}</p></div>}
        <Field label={kind === "send" ? "Amount in ETH" : "ETH per wallet"}><input type="text" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required autoComplete="off" /></Field>
        <FormError message={error} />
        <button className="btn-primary w-full" type="submit" disabled={busy || !amount || (kind !== "send" && !targets.length)}>{busy ? "Preparing review…" : "Review transfer"}<ArrowRight size={17} /></button>
        <p className="flex items-center justify-center gap-2 text-xs text-muted"><ShieldCheck size={15} />Nothing is sent until you confirm the review.</p>
      </form>}
    </>}
  </Modal>;
}
