"use client";

import Link from "next/link";
import { useRef, useState, useSyncExternalStore } from "react";

type Item = { name: string; quantity: number; unit_amount: number };
type Draft = {
  client_name: string;
  client_email: string;
  currency: string;
  items: Item[];
  due_in_days: number;
  note: string;
  language: "en" | "ar";
  missing: string[];
};
type Sent = { id: string; invoice_number: string; amount?: { value: string; currency_code: string }; due_date: string };

const EMPTY: Draft = { client_name: "", client_email: "", currency: "USD", items: [{ name: "", quantity: 1, unit_amount: 0 }], due_in_days: 14, note: "", language: "en", missing: [] };

// Minimal typing for the browser's speech recognition (Chrome/Safari ship it prefixed).
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
};
const speechApi = () =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as Record<string, unknown>).SpeechRecognition ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as
        | (new () => Recognition)
        | undefined;

const money = (n: number, c: string) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
  } catch {
    return `${n.toFixed(2)} ${c}`;
  }
};

export function Composer({ freelancerName }: { freelancerName: string }) {
  const [text, setText] = useState("");
  const [lang, setLang] = useState<"en-US" | "ar-EG">("en-US");
  const [listening, setListening] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const rec = useRef<Recognition | null>(null);

  // Speech support is a browser fact: false while server rendering, real value once hydrated.
  const canListen = useSyncExternalStore(
    () => () => {},
    () => Boolean(speechApi()),
    () => false,
  );

  function toggleMic() {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const Api = speechApi();
    if (!Api) return;
    const r = new Api();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => setText(Array.from(e.results).map((res) => res[0].transcript).join(" "));
    r.onend = () => setListening(false);
    r.onerror = () => {
      setListening(false);
      setError("The microphone didn't pick that up. Try again, or type instead.");
    };
    rec.current = r;
    setError(null);
    setListening(true);
    r.start();
  }

  async function makeDraft() {
    setBusy("draft");
    setError(null);
    try {
      const res = await fetch("/api/invoices/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setDraft({ ...body, items: body.items.length ? body.items : EMPTY.items });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!draft) return;
    setBusy("send");
    setError(null);
    try {
      const res = await fetch("/api/invoices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setSent(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const update = (patch: Partial<Draft>) => draft && setDraft({ ...draft, ...patch });
  const updateItem = (i: number, patch: Partial<Item>) => draft && update({ items: draft.items.with(i, { ...draft.items[i], ...patch }) });
  const total = draft ? draft.items.reduce((s, it) => s + it.quantity * it.unit_amount, 0) : 0;
  const field = "w-full min-w-0 rounded-md border border-line bg-paper px-3 py-2 text-ink";

  if (sent) {
    return (
      <section className="grid gap-4 rounded-xl border border-line bg-card p-6">
        <span aria-hidden className="grid h-10 w-10 place-items-center rounded-full bg-cleared text-xl text-white">
          ✓
        </span>
        <h2 className="font-display text-2xl font-semibold tracking-tight">Invoice sent with PayPal</h2>
        <p className="text-muted">
          {sent.invoice_number} · {sent.amount ? money(Number(sent.amount.value), sent.amount.currency_code) : ""} · due {sent.due_date}. PayPal
          emailed it from {freelancerName}, with a link the client can use to let their AI assistant pay it.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/" className="rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white">
            See it in receivables
          </Link>
          <button
            onClick={() => {
              setSent(null);
              setDraft(null);
              setText("");
            }}
            className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold"
          >
            New invoice
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="grid gap-6">
      <section className="grid gap-3 rounded-xl border border-line bg-card p-5">
        <label htmlFor="say" className="font-medium">
          What should we bill?
        </label>
        <textarea
          id="say"
          dir="auto"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Bill Acme Studio 1,200 dollars for the promo video edit, due in 14 days. billing@acme.com"
          className={`${field} text-base leading-relaxed`}
        />
        <div className="flex flex-wrap items-center gap-3">
          {canListen && (
            <>
              <button
                type="button"
                onClick={toggleMic}
                aria-pressed={listening}
                className={`rounded-lg border px-4 py-2.5 text-sm font-semibold ${listening ? "border-pending bg-pending-soft text-pending" : "border-line"}`}
              >
                {listening ? "● Listening… tap to stop" : "🎙 Speak"}
              </button>
              <div role="group" aria-label="Voice language" className="flex overflow-hidden rounded-lg border border-line text-sm">
                {(["en-US", "ar-EG"] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLang(l)}
                    aria-pressed={lang === l}
                    className={`px-3 py-2 ${lang === l ? "bg-ink text-white" : ""}`}
                  >
                    {l === "en-US" ? "English" : "العربية"}
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            onClick={makeDraft}
            disabled={!text.trim() || busy !== null}
            className="ms-auto rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy === "draft" ? "Drafting…" : "Draft invoice"}
          </button>
        </div>
        {!draft && (
          <button type="button" onClick={() => setDraft(EMPTY)} className="w-fit text-sm text-muted underline-offset-2 hover:underline">
            Or fill the invoice by hand
          </button>
        )}
      </section>

      {error && (
        <p role="alert" className="rounded-lg border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
          {error}
        </p>
      )}

      {draft && (
        <section className="grid gap-5 rounded-xl border-2 border-ink bg-card p-4 sm:p-6" aria-label="Review the draft">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-2xl font-semibold tracking-tight">Check before sending</h2>
            <p className="font-display text-2xl font-semibold tabular-nums">{money(total, draft.currency)}</p>
          </div>
          {draft.missing.length > 0 && (
            <p className="text-sm text-pending">Still needed: {draft.missing.map((m) => m.replace("client_email", "client email")).join(", ")}.</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted">Client</span>
              <input dir="auto" className={field} value={draft.client_name} onChange={(e) => update({ client_name: e.target.value })} />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted">Client email (PayPal sends the invoice here)</span>
              <input
                type="email"
                className={field}
                value={draft.client_email}
                onChange={(e) => update({ client_email: e.target.value.trim(), missing: draft.missing.filter((m) => m !== "client_email") })}
              />
            </label>
          </div>

          <div className="grid gap-2">
            <span className="text-sm text-muted">Line items</span>
            {draft.items.map((it, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_4.5rem_7rem]">
                <input dir="auto" aria-label="Item" className={`${field} col-span-2 sm:col-span-1`} value={it.name} onChange={(e) => updateItem(i, { name: e.target.value })} />
                <input aria-label="Quantity" type="number" min={1} className={`${field} tabular-nums`} value={it.quantity} onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })} />
                <input aria-label="Price" type="number" min={0} step="0.01" className={`${field} tabular-nums`} value={it.unit_amount} onChange={(e) => updateItem(i, { unit_amount: Number(e.target.value) })} />
              </div>
            ))}
            <button type="button" onClick={() => update({ items: [...draft.items, { name: "", quantity: 1, unit_amount: 0 }] })} className="w-fit text-sm font-medium text-cleared">
              + Add line
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-[8rem_10rem_1fr]">
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted">Currency</span>
              <input className={`${field} uppercase`} maxLength={3} value={draft.currency} onChange={(e) => update({ currency: e.target.value.toUpperCase() })} />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted">Due in (days)</span>
              <input type="number" min={0} max={365} className={`${field} tabular-nums`} value={draft.due_in_days} onChange={(e) => update({ due_in_days: Math.trunc(Number(e.target.value)) })} />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted">Note to client</span>
              <input dir="auto" className={field} value={draft.note} onChange={(e) => update({ note: e.target.value })} />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <button type="button" onClick={send} disabled={busy !== null} className="rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
              {busy === "send" ? "Sending…" : `Send ${money(total, draft.currency)} invoice with PayPal`}
            </button>
            <button type="button" onClick={() => setDraft(null)} className="text-sm text-muted hover:underline">
              Discard draft
            </button>
          </div>
          <p className="text-xs text-muted">Sent from {freelancerName}. The invoice includes a link that lets the client connect their AI assistant to pay it.</p>
        </section>
      )}
    </div>
  );
}
