import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDownLeft, ArrowRight, ArrowSquareOut, ArrowUpRight, ArrowsClockwise, CheckCircle, Circle, Clock, DownloadSimple, GearSix, Key, LockSimple, Monitor, PencilSimple, Plus, ShieldCheck, SquaresFour, Stack, Wallet, WarningCircle, X, MagnifyingGlass, CaretRight } from "@phosphor-icons/react";
import type { StudioNetwork, StudioState, TransferInput, WalletView } from "../src/studio/types.js";
import { api, connect, download } from "./api.js";
import { balance, CopyButton, Field, FormError, Modal, short, WalletMark } from "./components.js";
import { TransferDialog } from "./TransferDialog.js";
import { SepoliaApp } from "./SepoliaApp.js";
import { CurveApp } from "./CurveApp.js";

type Page = "wallets" | "activity" | "settings";
type Dialog = "unlock" | "add" | "rename" | "fund" | TransferInput["kind"] | null;

function App() {
  const [state, setState] = useState<StudioState | null>(null);
  const [network, setNetwork] = useState<StudioNetwork>("local");
  const [page, setPage] = useState<Page>("wallets");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [focused, setFocused] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  const currentNetwork = useRef(network);
  currentNetwork.current = network;

  const refresh = useCallback(async () => {
    const requestedNetwork = currentNetwork.current;
    setRefreshing(true);
    try {
      const next = await api<StudioState>(`state?network=${requestedNetwork}`);
      if (requestedNetwork === currentNetwork.current) {
        setState(next); setError(""); setFocused(old => old || next.wallets[0]?.address || "");
      }
    } catch (e) { setError((e as Error).message); }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => { void connect().then(() => setReady(true)).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!ready) return;
    void refresh();
    const interval = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15_000);
    return () => clearInterval(interval);
  }, [ready, network, refresh]);
  useEffect(() => { if (message) { const timer = setTimeout(() => setMessage(""), 6500); return () => clearTimeout(timer); } }, [message]);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true); setError("");
    try { await work(); setMessage(success); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const open = (next: Dialog) => { if (!state?.unlocked && next !== "unlock") setDialog("unlock"); else setDialog(next); };
  const visible = state?.wallets.filter(w => `${w.label} ${w.address}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const wallet = state?.wallets.find(w => w.address === focused) ?? state?.wallets[0];
  const targets = selected.length ? selected : state?.wallets.map(w => w.address) ?? [];
  const total = state?.wallets.every(w => w.balance !== null) ? state.wallets.reduce((sum, w) => sum + Number(w.balance), 0).toLocaleString("en-US", { maximumFractionDigits: 5 }) : "—";
  const exportAddresses = () => { download("wallet-addresses.json", state?.wallets.map(({ address, label }) => ({ address, label }))); setMessage("Wallet addresses exported. No private keys included."); };

  return <div className="min-h-[100dvh] bg-canvas text-ink">
    <aside className="sidebar">
      <a href="/" className="brand" onClick={e => { e.preventDefault(); setPage("wallets"); }}><span className="brand-mark"><SquaresFour size={25} weight="fill" /></span><span className="font-semibold tracking-tight">Wallet Studio<span className="mt-1 block text-[11px] font-normal tracking-wide text-muted">LOCAL WORKSPACE</span></span></a>
      <div className="px-6 pt-10 pb-3 text-[10px] font-semibold tracking-[.16em] text-muted">WORKSPACE</div>
      <nav className="grid gap-1 px-3" aria-label="Main navigation">{([
        ["wallets", Wallet, "Wallets"], ["activity", Clock, "Activity"], ["settings", GearSix, "Vault settings"],
      ] as const).map(([key, Icon, label]) => <button key={key} onClick={() => setPage(key)} className={`nav-item ${page === key ? "active" : ""}`} aria-current={page === key ? "page" : undefined}><Icon size={19} />{label}{key === "wallets" && state?.vaultExists && <span className="ml-auto text-xs">{state.wallets.length}</span>}</button>)}</nav>
      <div className="sidebar-foot"><div className="mb-3 flex items-center gap-2 text-xs font-medium"><span className="status-dot" />Running on your computer</div><p className="text-xs leading-relaxed text-muted">Keys are encrypted on disk.<br />Your vault stays local.</p><div className="mt-5 flex items-center gap-2 border-t border-line pt-4 text-xs text-muted"><Monitor size={15} />127.0.0.1 · Port 4310</div></div>
    </aside>

    <div className="workspace">
      <header className="topbar"><div className="flex items-center gap-2 text-xs text-muted"><span className="hidden sm:inline">Workspace</span><CaretRight size={12} className="hidden sm:block" /><span className="capitalize text-ink">{page === "settings" ? "Vault settings" : page}</span></div>
        <div className="flex items-center gap-3"><label className="network-picker"><span className="status-dot" /><span className="sr-only">Network</span><select value={network} disabled={busy || !!dialog} onChange={e => { setNetwork(e.target.value as StudioNetwork); setSelected([]); setState(old => old ? { ...old, wallets: old.wallets.map(w => ({ ...w, balance: null })), blockNumber: null, activity: [], network: old.networks.find(n => n.key === e.target.value)!, rpcError: "Connecting to network…" } : old); }}><option value="local">Local EVM</option><option value="sepolia">Base Sepolia</option><option value="mainnet">Base mainnet · Read-only</option></select></label>
          {state?.vaultExists && <button className="btn-quiet" disabled={busy} onClick={() => state.unlocked ? void run(() => api("lock", {}), "Vault locked.") : setDialog("unlock")}><LockSimple size={16} /><span className="hidden sm:inline">{state.unlocked ? "Lock vault" : "Unlock vault"}</span></button>}
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-5 py-8 md:px-10 lg:px-12">
        {error && <div role="alert" className="error-banner"><WarningCircle size={18} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}><X size={16} /></button></div>}
        {!state ? <><div className="skeleton mb-5 h-9 w-64" /><div className="skeleton h-20" /><div className="skeleton mt-7 h-96" />{error && <button className="btn-secondary mt-5" onClick={() => { setReady(true); void refresh(); }}>Try again</button>}</> : !state.vaultExists ? <Setup onDone={async () => { await refresh(); setMessage("Your ten wallets are ready. Add test ETH to start."); }} /> : <>
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">{page === "wallets" ? "YOUR WALLET WORKSPACE" : page === "activity" ? "ON-CHAIN ACTIVITY" : "LOCAL SECURITY"}</p><h1 className="mt-2 text-[32px] font-semibold tracking-[-.04em]">{page === "wallets" ? "Wallets" : page === "activity" ? "Activity" : "Vault settings"}{page === "wallets" && <span className="ml-3 align-middle text-xl font-normal text-muted">{state.wallets.length.toString().padStart(2, "0")}</span>}</h1><p className="mt-2 text-sm text-muted">{page === "wallets" ? "Create, fund, and move ETH between your wallets." : page === "activity" ? "Follow transfers from submission to confirmation." : "Manage access and keep an encrypted copy of your wallets."}</p></div>
            <div className="flex gap-2"><button className="btn-secondary" onClick={() => void refresh()} disabled={refreshing || busy}><ArrowsClockwise size={16} />{refreshing ? "Refreshing…" : "Refresh"}</button>{page === "wallets" && <button className="btn-primary" disabled={busy} onClick={() => open("add")}><Plus size={16} />Create wallets</button>}</div>
          </div>
          {state.rpcError && <div className="mb-5 flex gap-3 rounded-xl border border-line bg-white px-4 py-3 text-sm"><WarningCircle size={18} className="shrink-0 text-muted" /><span>{state.rpcError}</span></div>}
          {!state.unlocked && <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-line bg-white px-5 py-3 text-sm"><span className="flex items-center gap-2"><LockSimple size={17} />Vault locked. Balances are available; unlock to manage wallets.</span><button className="text-accent font-semibold" onClick={() => setDialog("unlock")}>Unlock</button></div>}
          {page === "wallets" ? <>
            <section className="stats-strip" aria-label="Wallet overview"><div><p>Total balance</p><strong>{total}<span>ETH</span></strong></div><div><p>Wallets in vault</p><strong>{state.wallets.length.toString().padStart(2, "0")}</strong></div><div><p>Network</p><strong className="!text-lg">{state.network.name}</strong><span className="mt-1 block text-xs text-muted">{state.network.test ? "Test environment" : "Read-only"}</span></div><div><p>Latest block</p><strong className="!text-lg font-mono">{state.blockNumber ?? "—"}</strong><span className="mt-1 block text-xs text-muted">Chain {state.network.chainId}</span></div></section>
            <div className="wallet-layout mt-7">
              <section className="min-w-0 rounded-2xl border border-line bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4"><h2 className="text-sm font-semibold">All wallets</h2><label className="search-box"><MagnifyingGlass size={15} /><span className="sr-only">Search wallets</span><input placeholder="Search name or address" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
                <div className="overflow-x-auto"><table className="wallet-table"><thead><tr><th className="w-10"><input className="checkbox" type="checkbox" aria-label="Select all wallets" checked={visible.length > 0 && visible.every(w => selected.includes(w.address))} onChange={e => setSelected(e.target.checked ? visible.map(w => w.address) : [])} /></th><th>Wallet</th><th>Address</th><th className="text-right">Balance</th><th className="w-8"><span className="sr-only">Details</span></th></tr></thead><tbody>{visible.map((w, i) => <tr key={w.address} className={wallet?.address === w.address ? "focused-row" : ""}><td><input className="checkbox" type="checkbox" aria-label={`Select ${w.label}`} checked={selected.includes(w.address)} onChange={e => setSelected(old => e.target.checked ? [...old, w.address] : old.filter(a => a !== w.address))} /></td><td><button className="flex items-center gap-3 text-left" onClick={() => setFocused(w.address)}><WalletMark address={w.address} /><span><span className="block font-medium">{w.label}</span><span className="mt-0.5 block text-[10px] text-muted">EVM wallet · {String(i + 1).padStart(2, "0")}</span></span></button></td><td><div className="flex items-center gap-1 font-mono text-xs text-muted"><span title={w.address}>{short(w.address)}</span><CopyButton text={w.address} label={`Copy ${w.label} address`} /></div></td><td className="text-right"><span className="font-mono text-sm font-medium">{balance(w.balance)}</span><span className="ml-1 text-[10px] text-muted">ETH</span></td><td><button className="icon-button" aria-label={`View ${w.label}`} onClick={() => setFocused(w.address)}><CaretRight size={15} /></button></td></tr>)}</tbody></table>{visible.length === 0 && <div className="px-5 py-16 text-center text-sm text-muted">No wallets match your search.<button className="mx-auto mt-3 block text-accent" onClick={() => setQuery("")}>Clear search</button></div>}</div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-xs text-muted"><span>{selected.length ? `${selected.length} selected` : `${visible.length} wallets · Encrypted locally`}</span><button className="flex items-center gap-1.5 hover:text-ink" onClick={exportAddresses}><DownloadSimple size={13} />Export addresses</button></div>
              </section>
              <aside className="grid content-start gap-5">{wallet && <WalletDetail wallet={wallet} state={state} onSend={() => open("send")} onRename={() => open("rename")} />}
                <section className="rounded-2xl border border-line bg-white p-5"><div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-semibold">Quick actions</h2><span className="text-[10px] text-muted">{selected.length ? `${selected.length} selected` : "ALL WALLETS"}</span></div>
                  {state.network.key === "local" && <button className="quick-action" disabled={busy || !!state.rpcError} onClick={() => open("fund")}><span className="action-icon"><Plus size={19} /></span><span><strong>Add test ETH</strong><small>10 ETH to {selected.length ? "selected wallets" : "every wallet"}</small></span><ArrowUpRight size={15} /></button>}
                  <button className="quick-action" disabled={!state.network.canSend || !!state.rpcError} onClick={() => open("distribute")}><span className="action-icon"><Stack size={19} /></span><span><strong>Distribute ETH</strong><small>One wallet to several</small></span><ArrowUpRight size={15} /></button>
                  <button className="quick-action" disabled={!state.network.canSend || !!state.rpcError} onClick={() => open("collect")}><span className="action-icon"><ArrowDownLeft size={19} /></span><span><strong>Collect ETH</strong><small>Several wallets to one</small></span><ArrowUpRight size={15} /></button>
                </section>
                <div className="px-1"><div className="mb-2 flex items-center gap-2 text-xs font-medium text-accent"><ShieldCheck size={17} />{state.network.key === "local" ? "A safe place to test" : state.network.key === "sepolia" ? "Connected to Base Sepolia" : "Mainnet is read-only"}</div><p className="text-xs leading-[1.7] text-muted">{state.network.key === "local" ? "This is a local EVM running on your computer. Test ETH has no monetary value." : state.network.key === "sepolia" ? "Fund a wallet with Sepolia test ETH, then use it to distribute funds to the others." : "You can view balances here. Sending is available on Local EVM and Base Sepolia."}</p></div>
              </aside>
            </div>
            {state.activity.length > 0 && <section className="mt-8"><div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-semibold">Recent activity</h2><button className="flex items-center gap-1 text-xs text-muted hover:text-ink" onClick={() => setPage("activity")}>View all<ArrowRight size={13} /></button></div><ActivityList state={state} limit={3} /></section>}
          </> : page === "activity" ? <ActivityList state={state} /> : <div className="grid max-w-3xl gap-5"><section className="settings-section"><ShieldCheck size={26} className="text-accent" /><div><h2 className="font-semibold">Encrypted wallet vault</h2><p className="mt-2 text-sm leading-relaxed text-muted">Your {state.wallets.length} wallets are encrypted with your passphrase. Private keys never appear in the dashboard. The vault locks after 15 minutes without a protected action.</p><p className="mt-3 text-xs text-muted">Stored in bundler/data/studio/vault.json</p></div></section><section className="settings-section"><DownloadSimple size={26} className="text-accent" /><div><h2 className="font-semibold">Back up your wallets</h2><p className="mt-2 text-sm leading-relaxed text-muted">Download an encrypted copy. Keep your passphrase separately; it is required to restore access. Losing both the vault and its backup means losing these wallets.</p><button className="btn-secondary mt-4" disabled={busy} onClick={() => state.unlocked ? void run(async () => download("wallet-studio-encrypted-backup.json", await api("backup")), "Encrypted backup downloaded.") : setDialog("unlock")}><DownloadSimple size={16} />Download encrypted backup</button></div></section><section className="settings-section"><Wallet size={26} className="text-accent" /><div><h2 className="font-semibold">Wallet addresses</h2><p className="mt-2 text-sm text-muted">Export labels and public addresses to use in your other tools.</p><button className="btn-secondary mt-4" onClick={exportAddresses}>Export addresses</button></div></section></div>}
        </>}
        <footer className="mt-9 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[11px] text-muted"><span>Wallet Studio <span className="mx-2 text-line">/</span> Local-first wallet testing</span><span className="flex items-center gap-1.5"><Circle size={7} weight="fill" className="text-accent" />{network === "local" ? "Local EVM · Test funds only" : network === "sepolia" ? "Base Sepolia · Test funds only" : "Base mainnet · Read-only"}</span></footer>
      </main>
    </div>
    {message && <div role="status" className="toast"><CheckCircle size={20} className="text-accent" />{message}<button aria-label="Dismiss notification" onClick={() => setMessage("")}><X size={15} /></button></div>}
    {state && dialog && (["send", "distribute", "collect"].includes(dialog) ? <TransferDialog state={state} kind={dialog as TransferInput["kind"]} focused={wallet?.address ?? ""} selected={selected} onClose={() => { setDialog(null); void refresh(); }} onDone={text => { setMessage(text); void refresh(); }} /> : <ActionDialog kind={dialog as "unlock" | "add" | "rename" | "fund"} wallet={wallet} targets={targets} onClose={() => setDialog(null)} onDone={async text => { setDialog(null); setMessage(text); await refresh(); }} />)}
  </div>;
}

function Setup({ onDone }: { onDone: () => Promise<void> }) {
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <section className="setup-layout py-7 md:py-14"><div><span className="pill"><span className="status-dot" />LOCAL WALLET WORKSPACE</span><h1 className="mt-7 max-w-lg text-[42px] leading-[1.1] font-semibold tracking-[-.055em]">Ten wallets.<br /><span className="text-accent">One place to test.</span></h1><p className="mt-5 max-w-sm text-sm leading-7 text-muted">Create a private wallet vault and start experimenting with transfers on your own local EVM.</p><ol className="mt-10 grid gap-6">{[["01", "Create your vault", "Ten new EVM wallets, encrypted with your passphrase."], ["02", "Add free test ETH", "Fund all ten wallets from the dashboard."], ["03", "Move funds and verify", "Send, distribute, or collect ETH. Watch each receipt arrive."]].map(([n, title, detail]) => <li key={n} className="flex gap-4"><span className="step-number">{n}</span><div><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 max-w-xs text-xs leading-6 text-muted">{detail}</p></div></li>)}</ol></div>
    <div className="rounded-2xl border border-line bg-white p-7 md:p-9"><div className="mb-5 inline-flex rounded-xl bg-soft p-3 text-accent"><Key size={27} /></div><h2 className="text-xl font-semibold tracking-tight">Create your wallet vault</h2><p className="mt-2 text-sm leading-6 text-muted">Choose a passphrase you can keep safely. It stays on this computer and is never saved in your browser.</p><form className="mt-7 grid gap-5" onSubmit={async event => { event.preventDefault(); setError(""); if (passphrase !== repeat) { setError("The passphrases do not match."); return; } setBusy(true); try { await api("setup", { passphrase }); setPassphrase(""); setRepeat(""); await onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Field label="Vault passphrase" hint="At least 16 characters. A few unrelated words work well."><input type="password" autoComplete="new-password" minLength={16} maxLength={512} value={passphrase} onChange={e => setPassphrase(e.target.value)} required /></Field><Field label="Confirm passphrase"><input type="password" autoComplete="new-password" minLength={16} maxLength={512} value={repeat} onChange={e => setRepeat(e.target.value)} required /></Field><FormError message={error} /><button className="btn-primary mt-1 w-full" disabled={busy}>{busy ? "Creating your ten wallets…" : "Create vault & 10 wallets"}<ArrowRight size={17} /></button><p className="flex items-start gap-2 text-[11px] leading-5 text-muted"><ShieldCheck size={16} className="mt-0.5 shrink-0" />New keys are generated locally. Existing bundler wallets are kept separate.</p></form></div>
  </section>;
}

function WalletDetail({ wallet, state, onSend, onRename }: { wallet: WalletView; state: StudioState; onSend: () => void; onRename: () => void }) {
  return <section className="rounded-2xl border border-line bg-white p-5"><div className="mb-5 flex items-center justify-between"><span className="text-[10px] font-semibold tracking-[.1em] text-muted">WALLET DETAILS</span><button className="icon-button" aria-label="Rename wallet" onClick={onRename}><PencilSimple size={15} /></button></div><WalletMark address={wallet.address} large /><h2 className="mt-4 text-xl font-semibold tracking-tight">{wallet.label}</h2><div className="mt-2 flex items-start gap-1"><p className="break-all font-mono text-[11px] leading-5 text-muted">{wallet.address}</p><CopyButton text={wallet.address} /></div><div className="my-5 border-y border-line py-4"><p className="text-[11px] text-muted">Available balance</p><p className="mt-1 font-mono text-[26px] tracking-tight">{balance(wallet.balance)}<span className="ml-2 text-xs text-muted">ETH</span></p></div><button className="btn-primary w-full" disabled={!state.network.canSend || !!state.rpcError} onClick={onSend}><ArrowUpRight size={17} />Send ETH</button>{state.network.explorer && <a className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted" href={`${state.network.explorer}/address/${wallet.address}`} target="_blank" rel="noreferrer">View on explorer<ArrowSquareOut size={13} /></a>}</section>;
}

function ActivityList({ state, limit = 80 }: { state: StudioState; limit?: number }) {
  if (!state.activity.length) return <div className="rounded-2xl border border-line bg-white py-20 text-center"><Clock size={32} className="mx-auto mb-4 text-muted" /><h2 className="font-semibold">No activity yet</h2><p className="mt-2 text-sm text-muted">Add test ETH or send your first transfer to see it here.</p></div>;
  const label = (address: string) => state.wallets.find(w => w.address === address)?.label ?? short(address);
  return <div className="divide-y divide-line rounded-2xl border border-line bg-white">{state.activity.slice(0, limit).map(row => <div key={row.id} className="flex flex-wrap items-center gap-4 px-5 py-4"><span className="action-icon">{row.kind === "test-funds" ? <Plus size={18} /> : <ArrowUpRight size={18} />}</span><div className="min-w-0 flex-1"><p className="text-sm font-medium">{row.kind === "test-funds" ? `Test ETH added to ${label(row.to)}` : `${label(row.from!)} → ${label(row.to)}`}</p><p className="mt-1 text-[11px] text-muted">{new Date(row.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}{row.hash && <span className="ml-3 inline-flex items-center gap-1 font-mono">{state.network.explorer ? <a href={`${state.network.explorer}/tx/${row.hash}`} target="_blank" rel="noreferrer">{short(row.hash)}</a> : short(row.hash)}<CopyButton text={row.hash} label="Copy transaction hash" /></span>}</p></div><div className="text-right"><p className="font-mono text-sm font-medium">{row.amount} ETH</p><p className={`mt-1 text-[10px] ${row.status === "confirmed" ? "text-accent" : "text-muted"}`}>{row.status === "confirmed" ? "Confirmed" : row.status === "reverted" ? "Reverted" : "Awaiting receipt"}</p></div></div>)}</div>;
}

function ActionDialog({ kind, wallet, targets, onClose, onDone }: { kind: "unlock" | "add" | "rename" | "fund"; wallet?: WalletView; targets: string[]; onClose: () => void; onDone: (message: string) => Promise<void> }) {
  const [value, setValue] = useState(kind === "rename" ? wallet?.label ?? "" : kind === "add" ? "1" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = kind === "unlock" ? "Unlock your vault" : kind === "rename" ? "Rename wallet" : kind === "fund" ? "Add test ETH" : "Create more wallets";
  return <Modal title={title} busy={busy} onClose={onClose}><form className="grid gap-5" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try {
    if (kind === "unlock") { await api("unlock", { passphrase: value }); setValue(""); await onDone("Vault unlocked."); }
    else if (kind === "rename") { await api("rename", { address: wallet?.address, label: value }); await onDone("Wallet renamed."); }
    else if (kind === "add") { await api("wallets", { count: Number(value) }); await onDone(`${value} wallet${value === "1" ? "" : "s"} created.`); }
    else { await api("test-funds", { network: "local", wallets: targets }); await onDone(`Added 10 test ETH to ${targets.length} wallets.`); }
  } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
    {kind === "unlock" ? <><p className="text-sm text-muted">Enter the passphrase you chose when creating this vault.</p><Field label="Vault passphrase"><input type="password" autoComplete="current-password" value={value} onChange={e => setValue(e.target.value)} required /></Field></> : kind === "rename" ? <Field label="Wallet name"><input value={value} onChange={e => setValue(e.target.value)} maxLength={40} required /></Field> : kind === "add" ? <><p className="text-sm text-muted">Each new wallet gets a unique EVM address and an encrypted private key.</p><Field label="Number of wallets"><input type="number" min={1} max={10} value={value} onChange={e => setValue(e.target.value)} required /></Field></> : <><div className="rounded-xl bg-soft p-5"><p className="text-sm font-medium">{targets.length} wallets × 10 test ETH</p><p className="mt-2 font-mono text-3xl tracking-tight">{targets.length * 10}<span className="ml-2 text-sm text-muted">ETH</span></p></div><p className="text-sm leading-6 text-muted">This adds free test funds to your selected wallets on the local EVM. Existing balances are preserved.</p></>}
    <FormError message={error} /><button className="btn-primary w-full" disabled={busy}>{busy ? "Working…" : kind === "unlock" ? "Unlock vault" : kind === "rename" ? "Save name" : kind === "add" ? "Create wallets" : "Add test ETH"}<ArrowRight size={17} /></button>
  </form></Modal>;
}

createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).get("network") === "sepolia" ? <SepoliaApp/> : location.pathname === "/curve" ? <CurveApp /> : <App />);
