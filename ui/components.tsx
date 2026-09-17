import { useEffect, useRef, type ReactNode } from "react";
import { X, Copy, Check } from "@phosphor-icons/react";
import { useState } from "react";

export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const balance = (value: string | null) => value === null ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 });

export function CopyButton({ text, label = "Copy address" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button className="icon-button" aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label} onClick={async event => {
    event.stopPropagation();
    try { await navigator.clipboard.writeText(text); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800); }
    catch { setCopied(false); }
  }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>;
}

export function Modal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="modal" aria-labelledby="modal-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="flex items-center justify-between gap-4 border-b border-line px-7 py-5"><h2 id="modal-title" className="text-xl font-semibold tracking-tight">{title}</h2><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    <div className="p-7">{children}</div>
  </dialog>;
}

export function WalletMark({ address, large = false }: { address: string; large?: boolean }) {
  return <div className={`wallet-mark ${large ? "wallet-mark-large" : ""}`} aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <span key={i} className={parseInt(address.slice(2 + i, 3 + i) || "a", 16) % 3 === 0 ? "filled" : ""} />)}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="grid gap-2 text-sm font-medium">{label}{children}{hint && <span className="text-xs font-normal leading-relaxed text-muted">{hint}</span>}</label>;
}

export function FormError({ message }: { message: string }) {
  return message ? <p role="alert" className="error-note">{message}</p> : null;
}
