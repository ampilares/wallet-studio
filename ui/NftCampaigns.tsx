import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowsClockwise, CheckCircle, Circle, DownloadSimple, Pause, Play, Plus, Stop, WarningCircle } from "@phosphor-icons/react";
import { formatEther, parseEther } from "viem";
import type { MintArgument, MintCampaign, MintCampaignInput, MintJob } from "../src/nft/types.js";
import type { StudioNetwork, StudioState } from "../src/studio/types.js";
import { api, download } from "./api.js";
import { Field, FormError, short } from "./components.js";
import { GENESIS, genesisInput } from "../src/nft/genesis.js";

type Stage = "campaigns" | "new" | "genesis" | "review" | "run" | "results";
type Pattern = "recipient-quantity" | "quantity" | "recipient" | "none";

const statusLabel: Record<MintJob["status"], string> = {
  draft: "Draft", preflight: "Checking", ready: "Ready", underfunded: "Underfunded", ineligible: "Ineligible",
  "sale-inactive": "Sale inactive", "sold-out": "Sold out", "contract-error": "Contract error", signed: "Signed",
  submitted: "Submitted", included: "Included", confirmed: "Confirmed", blocked: "Blocked", reverted: "Reverted",
  "cancelled-before-send": "Cancelled", unresolved: "Needs review",
};

function stageFor(campaign: MintCampaign): Stage {
  if (campaign.status === "completed") return "results";
  if (["running", "paused", "stopped", "partial"].includes(campaign.status)) return "run";
  return "review";
}

export function NftCampaigns({ state, network, selected, onUnlock, onMessage }: { state: StudioState; network: StudioNetwork; selected: string[]; onUnlock: () => void; onMessage: (message: string) => void }) {
  const [campaigns, setCampaigns] = useState<MintCampaign[]>([]);
  const [active, setActive] = useState<MintCampaign>();
  const [stage, setStage] = useState<Stage>("campaigns");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const rows = await api<MintCampaign[]>(`nft/campaigns?network=${network}`);
    setCampaigns(rows);
    setActive(current => current ? rows.find(row => row.id === current.id) ?? current : current);
  }, [network]);

  useEffect(() => { setStage("campaigns"); setActive(undefined); void refresh().catch(error => setError(error.message)); }, [refresh]);
  useEffect(() => {
    if (!active || !["running", "paused"].includes(active.status)) return;
    const timer = setInterval(() => void refresh().catch(() => undefined), 3_000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const perform = async (work: () => Promise<MintCampaign>, success: string) => {
    setBusy(true); setError("");
    try { const result = await work(); setActive(result); setStage(stageFor(result)); onMessage(success); await refresh(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  if (stage === "new") return <CampaignForm state={state} network={network} selected={selected} initial={active?.input} busy={busy} error={error} onCancel={() => { setError(""); setStage(active ? stageFor(active) : "campaigns"); }} onSubmit={input => perform(() => active ? api("nft/update", { id: active.id, campaign: input }) : api("nft/campaigns", input), active ? "Campaign revision saved. Run preflight again." : "Campaign draft saved.")} />;
  if (stage === "genesis") return <GenesisForm wallets={(active?.input.wallets ?? (selected.length ? selected : state.wallets.map(wallet => wallet.address))) as `0x${string}`[]} initial={active?.input} busy={busy} error={error} onCancel={() => setStage(active ? stageFor(active) : "campaigns")} onSubmit={input => perform(() => active ? api("nft/update", { id: active.id, campaign: input }) : api("nft/campaigns", input), "Genesis draft saved. Fund selected wallets on Base, then run preflight.")} />;
  if (active && stage !== "campaigns") return <CampaignDetail campaign={active} stage={stage} busy={busy} error={error} explorer={state.network.explorer} onBack={() => { setStage("campaigns"); setActive(undefined); setError(""); }} onEdit={() => setStage(active.input.adapter ? "genesis" : "new")} onPreflight={() => perform(() => api("nft/preflight", { id: active.id }), "Preflight review complete.")} onStart={() => state.unlocked ? perform(() => api("nft/start", { id: active.id }), "Mint run started.") : onUnlock()} onControl={action => perform(() => api(`nft/${action}`, { id: active.id }), action === "pause" ? "New mint submissions paused." : action === "resume" ? "Mint run resumed." : "New submissions stopped.")} onRetry={() => perform(() => api("nft/retry", { id: active.id }), "Unsent wallets checked again. Signed transactions are never reset.")} onReconcile={() => perform(() => api("nft/reconcile", { id: active.id }), "Recorded transaction receipts checked; no new transaction sent.")} />;

  return <>
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">NFT MINT OPERATIONS</p><h1 className="mt-2 text-[32px] font-semibold tracking-[-.04em]">Campaigns</h1><p className="mt-2 text-sm text-muted">Configure, simulate, execute, and reconcile one mint per wallet.</p></div><div className="flex gap-2"><button className="btn-secondary" disabled={busy} onClick={() => void refresh()}><ArrowsClockwise size={16} />Refresh</button><button className="btn-primary" disabled={!state.wallets.length} onClick={() => { setActive(undefined); setStage("new"); }}><Plus size={16} />New campaign</button></div></div>
    {error && <FormError message={error} />}
    {network === "mainnet" && <section className="form-card mb-5"><h2>BTC Genesis Miners · Base</h2><p className="mb-4 text-sm text-muted">Free public SeaDrop mint · one NFT per wallet · ETH needed for gas. The preset checks the live sale settings and uses the verified router.</p><button className="btn-primary" disabled={!state.wallets.length} onClick={() => { setActive(undefined); setError(""); setStage("genesis"); }}>Use BTC Genesis preset<ArrowRight size={16} /></button></section>}
    {!campaigns.length ? <section className="rounded-2xl border border-line bg-white px-6 py-20 text-center"><Circle size={34} className="mx-auto text-accent" /><h2 className="mt-4 font-semibold">No NFT campaigns on {state.network.name}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">Create a draft with the collection’s reviewed mint function. No transaction is sent until every wallet passes preflight and you start the run.</p><button className="btn-primary mt-6" onClick={() => setStage("new")}><Plus size={16} />Create campaign</button></section>
      : <div className="grid gap-3">{campaigns.map(campaign => <button key={campaign.id} className="campaign-row" onClick={() => { setActive(campaign); setStage(stageFor(campaign)); }}><span><strong>{campaign.input.name}</strong><small>{campaign.input.standard} · {short(campaign.input.contract)} · Revision {campaign.revision}</small></span><span><strong>{campaign.jobs.filter(job => job.status === "confirmed").length}/{campaign.input.wallets.length}</strong><small>{campaign.status}</small></span><ArrowRight size={17} /></button>)}</div>}
  </>;
}

function CampaignForm({ state, network, selected, initial, busy, error, onCancel, onSubmit }: { state: StudioState; network: StudioNetwork; selected: string[]; initial?: MintCampaignInput; busy: boolean; error: string; onCancel: () => void; onSubmit: (input: MintCampaignInput) => void }) {
  const wallets = initial?.wallets ?? (selected.length ? selected : state.wallets.map(wallet => wallet.address));
  const initialPattern: Pattern = !initial ? "recipient-quantity" : initial.arguments.length === 2 && initial.arguments[0]?.kind === "wallet" && initial.arguments[1]?.kind === "quantity" ? "recipient-quantity" : initial.arguments.length === 1 && initial.arguments[0]?.kind === "quantity" ? "quantity" : initial.arguments.length === 1 && initial.arguments[0]?.kind === "wallet" ? "recipient" : "none";
  const [name, setName] = useState(initial?.name ?? "");
  const [contract, setContract] = useState(initial?.contract ?? "");
  const [standard, setStandard] = useState<"ERC721" | "ERC1155">(initial?.standard ?? "ERC721");
  const [signature, setSignature] = useState(initial?.functionSignature ?? "function mint(address recipient, uint256 quantity) payable");
  const [functionName, setFunctionName] = useState(initial?.functionName ?? "mint");
  const [pattern, setPattern] = useState<Pattern>(initialPattern);
  const [quantity, setQuantity] = useState(String(initial?.quantity ?? 1));
  const [price, setPrice] = useState(initial ? formatEther(BigInt(initial.pricePerTokenWei)) : "0");
  const [feeBuffer, setFeeBuffer] = useState(initial ? formatEther(BigInt(initial.feeBufferWei)) : "0.0001");
  const [maxFee, setMaxFee] = useState(initial ? formatEther(BigInt(initial.maxFeePerWalletWei)) : "0.003");
  const [ceiling, setCeiling] = useState(initial ? formatEther(BigInt(initial.spendCeilingWei)) : "0.5");
  const [confirmations, setConfirmations] = useState(String(initial?.confirmations ?? 1));
  const [concurrency, setConcurrency] = useState(String(initial?.concurrency ?? 5));
  const [mainnetApproved, setMainnetApproved] = useState(initial?.mainnetApproved ?? false);
  const [formError, setFormError] = useState("");
  const args = useMemo<MintArgument[]>(() => pattern === "recipient-quantity" ? [{ kind: "wallet" }, { kind: "quantity" }] : pattern === "quantity" ? [{ kind: "quantity" }] : pattern === "recipient" ? [{ kind: "wallet" }] : [], [pattern]);
  const eth = (value: string) => parseEther(value || "0").toString();
  return <>
    <div className="mb-7"><button className="mb-5 flex items-center gap-2 text-xs text-muted" onClick={onCancel}><ArrowLeft size={14} />{initial ? "Campaign" : "Campaigns"}</button><p className="eyebrow">{initial ? "NEW REVISION" : "NEW CAMPAIGN"}</p><h1 className="mt-2 text-[32px] font-semibold tracking-[-.04em]">Configure mint</h1><p className="mt-2 text-sm text-muted">Use the exact payable mint function from the reviewed collection ABI.</p></div>
    <form className="grid max-w-4xl gap-5" onSubmit={event => { event.preventDefault(); setFormError(""); try { onSubmit({ name, network, contract: contract as `0x${string}`, standard, functionSignature: signature, functionName, arguments: args, wallets: wallets as `0x${string}`[], quantity: Number(quantity), pricePerTokenWei: eth(price), feeBufferWei: eth(feeBuffer), maxFeePerWalletWei: eth(maxFee), spendCeilingWei: eth(ceiling), confirmations: Number(confirmations), concurrency: Number(concurrency), mainnetApproved }); } catch { setFormError("Enter valid non-negative ETH amounts with no more than 18 decimal places."); } }}>
      <section className="form-card"><h2>Collection</h2><div className="form-grid"><Field label="Campaign name"><input value={name} maxLength={80} onChange={event => setName(event.target.value)} required /></Field><Field label="Collection contract"><input className="font-mono" placeholder="0x…" pattern="0x[a-fA-F0-9]{40}" value={contract} onChange={event => setContract(event.target.value)} required /></Field><Field label="Token standard"><select value={standard} onChange={event => setStandard(event.target.value as typeof standard)}><option>ERC721</option><option>ERC1155</option></select></Field><Field label="Selected wallets" hint="Choose wallets on the Wallets page first, or this uses the whole vault."><input value={`${wallets.length} wallet${wallets.length === 1 ? "" : "s"}`} readOnly /></Field></div></section>
      <section className="form-card"><h2>Reviewed mint call</h2><div className="form-grid"><Field label="Function signature" hint="Human-readable ABI; include payable when ETH is sent."><input className="font-mono" value={signature} onChange={event => setSignature(event.target.value)} required /></Field><Field label="Function name"><input className="font-mono" value={functionName} onChange={event => setFunctionName(event.target.value)} required /></Field><Field label="Argument mapping"><select value={pattern} onChange={event => setPattern(event.target.value as Pattern)}><option value="recipient-quantity">wallet address, quantity</option><option value="quantity">quantity</option><option value="recipient">wallet address</option><option value="none">no arguments</option></select></Field><Field label="Quantity per wallet"><input type="number" min={1} max={100} value={quantity} onChange={event => setQuantity(event.target.value)} required /></Field></div></section>
      <section className="form-card"><h2>Cost controls</h2><div className="form-grid"><Field label="Price per token (ETH)"><input inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} required /></Field><Field label="L1 / fee buffer per wallet (ETH)"><input inputMode="decimal" value={feeBuffer} onChange={event => setFeeBuffer(event.target.value)} required /></Field><Field label="Maximum fee per wallet (ETH)"><input inputMode="decimal" value={maxFee} onChange={event => setMaxFee(event.target.value)} required /></Field><Field label="Campaign spend ceiling (ETH)"><input inputMode="decimal" value={ceiling} onChange={event => setCeiling(event.target.value)} required /></Field><Field label="Confirmations"><input type="number" min={1} max={64} value={confirmations} onChange={event => setConfirmations(event.target.value)} /></Field><Field label="Concurrent wallets"><input type="number" min={1} max={10} value={concurrency} onChange={event => setConcurrency(event.target.value)} /></Field></div>{network === "mainnet" && <label className="mt-5 flex items-start gap-3 text-sm"><input className="checkbox mt-1" type="checkbox" checked={mainnetApproved} onChange={event => setMainnetApproved(event.target.checked)} /><span>I reviewed this exact mainnet contract, mint call, price, wallet count, and spend ceiling. The server-side mainnet send gate must also be enabled.</span></label>}</section>
      <FormError message={formError || error} /><div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button><button className="btn-primary" disabled={busy}>{busy ? "Saving…" : initial ? "Save new revision" : "Save draft"}<ArrowRight size={16} /></button></div>
    </form>
  </>;
}

function CampaignDetail({ campaign, stage, busy, error, explorer, onBack, onEdit, onPreflight, onStart, onControl, onRetry, onReconcile }: { campaign: MintCampaign; stage: Stage; busy: boolean; error: string; explorer?: string; onBack: () => void; onEdit: () => void; onPreflight: () => void; onStart: () => void; onControl: (action: "pause" | "resume" | "stop") => void; onRetry: () => void; onReconcile: () => void }) {
  const confirmed = campaign.jobs.filter(job => job.status === "confirmed").length;
  const ready = campaign.jobs.filter(job => job.status === "ready").length;
  const failed = campaign.jobs.filter(job => ["underfunded", "ineligible", "sale-inactive", "sold-out", "contract-error", "blocked", "reverted", "unresolved"].includes(job.status)).length;
  const totalEstimate = campaign.jobs.reduce((sum, job) => sum + BigInt(job.requiredWei || "0"), 0n);
  const exportResults = () => download(`nft-campaign-${campaign.id}.json`, { id: campaign.id, revision: campaign.revision, network: campaign.input.network, contract: campaign.input.contract, status: campaign.status, wallets: campaign.jobs.map(({ wallet, status, txHash, tokenIds, actualFeeWei, error, reason }) => ({ wallet, status, txHash, tokenIds, actualFeeWei, error, reason })) });
  return <>
    <button className="mb-5 flex items-center gap-2 text-xs text-muted" onClick={onBack}><ArrowLeft size={14} />Campaigns</button>
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">{stage === "review" ? "PREFLIGHT REVIEW" : stage === "results" ? "RESULTS" : "LIVE RUN"}</p><h1 className="mt-2 text-[32px] font-semibold tracking-[-.04em]">{campaign.input.name}</h1><p className="mt-2 text-sm text-muted">{campaign.input.standard} · {campaign.input.network} · {short(campaign.input.contract)} · revision {campaign.revision}</p></div><div className="flex flex-wrap gap-2">{campaign.jobs.length > 0 && <button className="btn-secondary" onClick={exportResults}><DownloadSimple size={16} />Export results</button>}{stage === "review" && <><button className="btn-secondary" disabled={busy} onClick={onEdit}>Edit as new revision</button><button className="btn-secondary" disabled={busy} onClick={onPreflight}><ArrowsClockwise size={16} />{campaign.reviewedAt ? "Run preflight again" : "Run preflight"}</button><button className="btn-primary" disabled={busy || campaign.status !== "reviewed"} onClick={onStart}><Play size={16} />Start minting</button></>}{stage === "run" && campaign.status === "running" && <><button className="btn-secondary" disabled={busy} onClick={() => onControl("pause")}><Pause size={16} />Pause</button><button className="btn-secondary" disabled={busy} onClick={() => onControl("stop")}><Stop size={16} />Stop new submissions</button></>}{stage === "run" && campaign.status === "paused" && <button className="btn-primary" disabled={busy} onClick={() => onControl("resume")}><Play size={16} />Resume</button>}{stage === "run" && ["partial", "stopped"].includes(campaign.status) && <button className="btn-secondary" disabled={busy} onClick={onRetry}><ArrowsClockwise size={16} />Check failed wallets</button>}</div></div>
    {error && <div className="mb-5"><FormError message={error} /></div>}
    {campaign.input.adapter && <section className="form-card mb-5"><h2>Free SeaDrop mint · 1 NFT per wallet</h2><p className="break-all text-xs text-muted">Collection: {campaign.input.contract}<br />Transaction destination: {GENESIS.seaDrop}<br />ETH sent to mint: 0. Each selected wallet pays its own Base gas.</p><p className="mt-3 text-xs text-muted">Review expires after 5 minutes. Base L1 fees are estimated with a buffer; the network does not offer an absolute L1 fee cap. No automatic scheduling or funding.</p><button className="btn-secondary mt-3" onClick={() => download("genesis-funding-addresses.json", { network: "Base mainnet", chainId: 8453, wallets: campaign.input.wallets.map(wallet => ({ wallet, shortfallWei: campaign.jobs.find(job => job.wallet === wallet)?.shortfallWei ?? null })) })}><DownloadSimple size={16} />Export funding addresses</button></section>}
    {campaign.jobs.some(job => job.txHash) && campaign.status !== "running" && <div className="mb-5 flex flex-wrap gap-2"><button className="btn-secondary" disabled={busy} onClick={onReconcile}><ArrowsClockwise size={16} />Reconcile transactions</button>{["partial", "paused"].includes(campaign.status) && <button className="btn-secondary" disabled={busy} onClick={() => onControl("resume")}>Recover / resume recorded run</button>}</div>}
    {campaign.status === "paused" && <button className="btn-secondary mb-5" disabled={busy} onClick={onPreflight}>Refresh expired preflight</button>}
    {campaign.status === "running" && <p className="mb-5 text-xs text-muted">If the server restarted, <button className="underline" disabled={busy} onClick={() => onControl("resume")}>recover the recorded run</button>. An active worker will refuse a second start; a crash lock requires inspection first.</p>}
    <section className="stats-strip mb-6"><div><p>Confirmed</p><strong>{confirmed}<span>/ {campaign.input.wallets.length}</span></strong></div><div><p>Ready</p><strong>{ready}</strong></div><div><p>Needs attention</p><strong>{failed}</strong></div><div><p>{campaign.reviewedAt ? "Max reviewed cost" : "Spend ceiling"}</p><strong className="!text-lg font-mono">{Number(formatEther(campaign.reviewedAt ? totalEstimate : BigInt(campaign.input.spendCeilingWei))).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH</strong></div></section>
    {campaign.status === "reviewed" && <div className="mb-5 flex gap-3 rounded-xl border border-[#bed4c5] bg-soft px-4 py-3 text-sm text-accent"><CheckCircle size={18} className="shrink-0" />All wallets simulated successfully. Starting creates real transactions on {campaign.input.network}.</div>}
    {campaign.jobs.length === 0 ? <section className="rounded-2xl border border-line bg-white px-6 py-16 text-center"><WarningCircle size={30} className="mx-auto text-muted" /><h2 className="mt-4 font-semibold">Preflight has not run</h2><p className="mt-2 text-sm text-muted">The collection bytecode, call arguments, eligibility, balance, gas, and budget still need to be checked.</p></section> : <div className="overflow-x-auto rounded-2xl border border-line bg-white"><table className="wallet-table"><thead><tr><th>Wallet</th><th>Status</th><th className="text-right">Required</th><th className="text-right">Actual fee</th><th>Transaction / token</th></tr></thead><tbody>{campaign.jobs.map(job => <tr key={job.id}><td><span className="font-mono text-xs">{short(job.wallet)}</span></td><td><span className={`job-status job-${job.status}`}>{statusLabel[job.status]}</span>{(job.reason || job.error) && <small className="mt-1 block max-w-xs whitespace-normal text-[10px] leading-4 text-muted">{job.reason || job.error}</small>}</td><td className="text-right font-mono text-xs">{formatEth(job.requiredWei)} ETH</td><td className="text-right font-mono text-xs">{job.actualFeeWei ? `${formatEth(job.actualFeeWei)} ETH` : "—"}</td><td className="font-mono text-xs">{job.txHash ? explorer ? <a className="text-accent" href={`${explorer}/tx/${job.txHash}`} target="_blank" rel="noreferrer">{short(job.txHash)}</a> : short(job.txHash) : "—"}{job.tokenIds.length > 0 && <small className="mt-1 block text-[10px] text-muted">Token {job.tokenIds.join(", ")}</small>}</td></tr>)}</tbody></table></div>}
  </>;
}

function GenesisForm({ wallets, initial, busy, error, onCancel, onSubmit }: { wallets: `0x${string}`[]; initial?: MintCampaignInput; busy: boolean; error: string; onCancel: () => void; onSubmit: (input: MintCampaignInput) => void }) {
  const defaults = initial ?? genesisInput(wallets);
  const [maxFee, setMaxFee] = useState(formatEther(BigInt(defaults.maxFeePerWalletWei)));
  const [buffer, setBuffer] = useState(formatEther(BigInt(defaults.feeBufferWei)));
  const [ceiling, setCeiling] = useState(formatEther(BigInt(defaults.spendCeilingWei)));
  const [approved, setApproved] = useState(false);
  const [localError, setLocalError] = useState("");
  const [live, setLive] = useState<{ matches: boolean; active: boolean; minted: string; maxSupply: string; startTime: number; endTime: number; mainnetSendEnabled: boolean }>();
  const refresh = () => { setLocalError(""); void api<NonNullable<typeof live>>("nft/genesis").then(setLive).catch(error => setLocalError(error.message)); };
  useEffect(() => { refresh(); }, []);
  return <>
    <button className="mb-5 flex items-center gap-2 text-xs text-muted" onClick={onCancel}><ArrowLeft size={14} />Campaigns</button>
    <p className="eyebrow">BASE MAINNET · PINNED SEADROP PRESET</p><h1 className="mt-2 mb-6 text-[32px] font-semibold tracking-[-.04em]">BTC Genesis Miners</h1>
    <form className="grid max-w-4xl gap-5" onSubmit={event => { event.preventDefault(); setLocalError(""); try { onSubmit({ ...genesisInput(wallets), maxFeePerWalletWei: parseEther(maxFee).toString(), feeBufferWei: parseEther(buffer).toString(), spendCeilingWei: parseEther(ceiling).toString(), mainnetApproved: approved }); } catch { setLocalError("Enter valid ETH amounts."); } }}>
      <section className="form-card"><h2>{wallets.length} selected wallet{wallets.length === 1 ? "" : "s"} · one NFT each · mint price 0 ETH</h2><p className="mb-3 text-sm text-muted">Select only the wallets you intend to use on the Wallets page. Fund each with ETH on Base (chain 8453), not Ethereum or Sepolia. Studio does not automatically fund or bridge.</p><p className="break-all text-xs leading-6 text-muted">Collection: {GENESIS.collection}<br />SeaDrop router: {GENESIS.seaDrop}<br />Permitted fee recipient: {GENESIS.feeRecipient}</p><p className="mt-3 text-sm">{live ? `${live.matches ? "Settings match preset" : "BLOCKED: settings changed"} · ${live.minted}/${live.maxSupply} minted · ${live.active ? "Sale active" : "Sale not active"}` : "Reading live Base settings…"}</p><p className="mt-2 text-xs text-muted">Opens {new Date(GENESIS.startTime * 1000).toLocaleString()} · closes {new Date(GENESIS.endTime * 1000).toLocaleString()} (your timezone).</p><p className="mt-2 text-xs text-muted">{live?.mainnetSendEnabled ? "Server mainnet-send gate enabled." : "Server mainnet-send gate disabled or not yet checked. Set MAINNET_SEND_ENABLED=true locally and restart before sending."}</p><button type="button" className="btn-secondary mt-3" onClick={refresh}><ArrowsClockwise size={16} />Refresh live settings</button></section>
      <section className="form-card"><h2>Gas and spending review</h2><div className="form-grid"><Field label="Maximum fee per wallet (ETH)"><input required inputMode="decimal" value={maxFee} onChange={event => setMaxFee(event.target.value)} /></Field><Field label="Extra fee buffer per wallet (ETH)"><input required inputMode="decimal" value={buffer} onChange={event => setBuffer(event.target.value)} /></Field><Field label="Total campaign ceiling (ETH)"><input required inputMode="decimal" value={ceiling} onChange={event => setCeiling(event.target.value)} /></Field><Field label="Execution"><input readOnly value="2 confirmations · 2 concurrent wallets" /></Field></div><p className="mt-3 text-xs text-muted">These are spending controls, not quoted mint fees. Preflight estimates Base execution + L1 data + operator fees. L1 fees can change after submission and cannot be absolutely capped on-chain.</p><label className="mt-5 flex items-start gap-3 text-sm"><input className="checkbox mt-1" type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} required /><span>I reviewed the collection, free public-mint call, {wallets.length} wallets, and fee ceilings. I understand Start minting sends real Base transactions.</span></label></section>
      <FormError message={localError || error} /><div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button><button className="btn-primary" disabled={busy || !approved || !wallets.length || live?.matches === false}>{busy ? "Saving…" : "Save Genesis draft"}<ArrowRight size={16} /></button></div>
    </form>
  </>;
}

function formatEth(value: string) { return Number(formatEther(BigInt(value))).toLocaleString(undefined, { maximumFractionDigits: 7 }); }
