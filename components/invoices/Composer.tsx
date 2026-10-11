"use client";

import Link from "next/link";
import { useRef, useState, useSyncExternalStore } from "react";
import { PAYPAL_CURRENCIES } from "@/lib/currency.mjs";
import { validateInvoiceForm, splitEvenly, formTotal, capPartAmount } from "@/lib/invoiceForm.mjs";
import { ReviewPanel } from "./ReviewPanel";

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
type PayMode = "full" | "milestones";
type Part = { name: string; amount: number; due_date: string };
type ScheduleSent = { link: string; total: number; currency: string; parts: number };

const PAY_MODES: { id: PayMode; label: string; hint: string }[] = [
  { id: "full", label: "In full", hint: "One invoice for the whole amount." },
  { id: "milestones", label: "Milestones", hint: "One PayPal invoice per milestone, each sent 3 days before its date. Your client approves the dates first." },
];

// Dates count from the server's "today" (the demo clock), which is what the schedule is checked against.
const isoIn = (fromIso: string, days: number) => new Date(Date.parse(`${fromIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// Minimal typing for the browser's speech recognition (Chrome/Safari ship it prefixed).
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  onerror: (e: { error: string }) => void;
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

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span role="alert" className="text-xs font-medium text-pending">
      {message}
    </span>
  );
}

export function Composer({
  freelancerName,
  todayIso,
  defaultCurrency,
  reviewEnabled = false,
}: {
  freelancerName: string;
  todayIso: string;
  defaultCurrency: string;
  reviewEnabled?: boolean;
}) {
  const empty = (): Draft => ({ client_name: "", client_email: "", currency: defaultCurrency, items: [{ name: "", quantity: 1, unit_amount: 0 }], due_in_days: 14, note: "", language: "en", missing: [] });
  const [text, setText] = useState("");
  const [lang, setLang] = useState<"en-US" | "ar-EG">("en-US");
  const [listening, setListening] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [payMode, setPayMode] = useState<PayMode>("full");
  const [parts, setParts] = useState<Part[]>([]);
  const [scheduleSent, setScheduleSent] = useState<ScheduleSent | null>(null);
  const [copied, setCopied] = useState(false);
  // Fields the freelancer has touched show their errors. A drafted invoice shows them all ("*").
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const rec = useRef<Recognition | null>(null);
  const keepListening = useRef(false);
  const spokenBefore = useRef("");

  // Speech support is a browser fact: false while server rendering, real value once hydrated.
  const canListen = useSyncExternalStore(
    () => () => {},
    () => Boolean(speechApi()),
    () => false,
  );

  // Tap to start, tap to stop. Browsers end a session after a pause, so it restarts until stopped.
  function startSession(before: string) {
    const Api = speechApi();
    if (!Api) return;
    const r = new Api();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = true;
    spokenBefore.current = before ? `${before.trimEnd()} ` : "";
    let latest = before;
    r.onresult = (e) => {
      const heard = Array.from(e.results)
        .map((res) => res[0].transcript)
        .join(" ")
        .trim();
      latest = spokenBefore.current + heard;
      setText(latest);
    };
    r.onend = () => {
      if (keepListening.current) startSession(latest);
      else setListening(false);
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // onend restarts or stops
      keepListening.current = false;
      setListening(false);
      setError(e.error === "not-allowed" ? "Allow the microphone for this site to speak your invoice." : "The microphone stopped. Tap Speak to try again, or type instead.");
    };
    rec.current = r;
    r.start();
  }

  function toggleMic() {
    if (listening) {
      keepListening.current = false;
      rec.current?.stop();
      setListening(false);
      return;
    }
    setError(null);
    keepListening.current = true;
    setListening(true);
    startSession(text);
  }

  async function makeDraft() {
    if (listening) toggleMic();
    setBusy("draft");
    setError(null);
    try {
      const res = await fetch("/api/invoices/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setDraft({ ...body, items: body.items.length ? body.items : empty().items });
      setTouched(new Set(["*"]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const total = draft ? formTotal(draft.items) : 0;
  const check = draft ? validateInvoiceForm({ draft, payMode, parts, todayIso }) : { valid: false, errors: {} as Record<string, string> };
  const errorFor = (key: string) => (touched.has("*") || touched.has(key) ? check.errors[key] : undefined);
  const touch = (key: string) => setTouched((t) => (t.has(key) ? t : new Set(t).add(key)));

  async function send() {
    if (!draft || !check.valid) {
      setTouched(new Set(["*"]));
      return;
    }
    setBusy("send");
    setError(null);
    try {
      if (payMode === "milestones") {
        const title = draft.items.map((it) => it.name.trim()).filter(Boolean).join(", ").slice(0, 120);
        const res = await fetch("/api/schedules", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "milestones", title, client_email: draft.client_email, client_name: draft.client_name, currency: draft.currency, parts }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        setScheduleSent({ ...body, parts: parts.length });
        return;
      }
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
  const removeItem = (i: number) => draft && update({ items: draft.items.filter((_, j) => j !== i) });
  const updatePart = (i: number, patch: Partial<Part>) => setParts(parts.with(i, { ...parts[i], ...patch }));
  const choosePayMode = (mode: PayMode) => {
    setPayMode(mode);
    if (mode === "milestones" && draft && parts.length === 0) {
      const first = isoIn(todayIso, draft.due_in_days);
      setParts(splitEvenly([{ name: "Milestone 1", amount: 0, due_date: first }, { name: "Milestone 2", amount: 0, due_date: isoIn(first, 30) }], total));
    }
  };
  // Adding or removing a milestone spreads the total evenly again; amounts stay editable after.
  const addPart = () => {
    const last = parts.at(-1)?.due_date || todayIso;
    setParts(splitEvenly([...parts, { name: `Milestone ${parts.length + 1}`, amount: 0, due_date: isoIn(last, 30) }], total));
  };
  const removePart = (i: number) => setParts(splitEvenly(parts.filter((_, j) => j !== i), total));
  const reset = () => {
    setSent(null);
    setScheduleSent(null);
    setDraft(null);
    setText("");
    setPayMode("full");
    setParts([]);
    setCopied(false);
    setTouched(new Set());
  };
  const field = "w-full min-w-0 rounded-md border bg-paper px-3 py-2 text-ink";
  const border = (key: string) => (errorFor(key) ? "border-pending" : "border-line");
  const removeBtn = "grid h-10 w-8 place-items-center self-start rounded-md text-lg text-muted hover:bg-line hover:text-ink disabled:opacity-25";

  if (scheduleSent) {
    return (
      <section className="grid gap-4 rounded-xl border border-line bg-card p-6">
        <span aria-hidden className="grid h-10 w-10 place-items-center rounded-full bg-cleared text-xl text-white">
          ✓
        </span>
        <h2 className="font-display text-2xl font-semibold tracking-tight">Schedule ready for your client</h2>
        <p className="text-muted">
          {money(scheduleSent.total, scheduleSent.currency)} in {scheduleSent.parts} milestones. Send your client this link. They approve the dates once and can
          turn on auto-pay. Nothing is invoiced until they approve.
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-line bg-paper p-2">
          <code className="min-w-0 flex-1 truncate px-2 text-sm">{scheduleSent.link}</code>
          <button
            type="button"
            onClick={() =>
              navigator.clipboard
                .writeText(scheduleSent.link)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
            className="rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/schedules" className="rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white">
            See your schedules
          </Link>
          <button onClick={reset} className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold">
            New invoice
          </button>
        </div>
      </section>
    );
  }

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
          <button onClick={reset} className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold">
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
          className={`${field} border-line text-base leading-relaxed`}
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
                    disabled={listening}
                    onClick={() => setLang(l)}
                    aria-pressed={lang === l}
                    className={`px-3 py-2 disabled:opacity-50 ${lang === l ? "bg-ink text-white" : ""}`}
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
        {listening && <p className="text-xs text-muted">Keep talking. It listens until you tap stop.</p>}
        {!draft && (
          <button
            type="button"
            onClick={() => {
              setDraft(empty());
              setTouched(new Set());
            }}
            className="w-fit text-sm text-muted underline-offset-2 hover:underline"
          >
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

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid content-start gap-1.5 text-sm">
              <span className="text-muted">Client name (optional)</span>
              <input dir="auto" className={`${field} border-line`} value={draft.client_name} onChange={(e) => update({ client_name: e.target.value })} />
            </label>
            <label className="grid content-start gap-1.5 text-sm">
              <span className="text-muted">Client email · PayPal sends the invoice here</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="off"
                aria-invalid={Boolean(errorFor("client_email"))}
                className={`${field} ${border("client_email")}`}
                value={draft.client_email}
                onChange={(e) => {
                  update({ client_email: e.target.value.trim() });
                  touch("client_email");
                }}
                onBlur={() => touch("client_email")}
              />
              <FieldError message={errorFor("client_email")} />
            </label>
          </div>

          <div className="grid gap-2">
            <div className="hidden grid-cols-[1fr_4.5rem_7rem_2rem] gap-2 text-xs font-medium uppercase tracking-wide text-muted sm:grid">
              <span>Item</span>
              <span>Qty</span>
              <span>Price ({draft.currency})</span>
              <span aria-hidden />
            </div>
            {draft.items.map((it, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_2rem] gap-x-2 gap-y-1 border-b border-line pb-2 sm:grid-cols-[1fr_4.5rem_7rem_2rem] sm:border-0 sm:pb-0">
                <label className="col-span-2 grid content-start gap-1 sm:col-span-1">
                  <span className="text-xs text-muted sm:sr-only">Item</span>
                  <input
                    dir="auto"
                    className={`${field} ${border(`items.${i}.name`)}`}
                    value={it.name}
                    onChange={(e) => {
                      updateItem(i, { name: e.target.value });
                      touch(`items.${i}.name`);
                    }}
                    onBlur={() => touch(`items.${i}.name`)}
                  />
                  <FieldError message={errorFor(`items.${i}.name`)} />
                </label>
                <button type="button" aria-label={`Remove item ${i + 1}`} disabled={draft.items.length <= 1} onClick={() => removeItem(i)} className={`${removeBtn} mt-5 sm:hidden`}>
                  ×
                </button>
                <label className="grid content-start gap-1">
                  <span className="text-xs text-muted sm:sr-only">Qty</span>
                  <input
                    type="number"
                    min={1}
                    className={`${field} ${border(`items.${i}.quantity`)} tabular-nums`}
                    value={it.quantity}
                    onChange={(e) => {
                      updateItem(i, { quantity: Number(e.target.value) });
                      touch(`items.${i}.quantity`);
                    }}
                    onBlur={() => touch(`items.${i}.quantity`)}
                  />
                  <FieldError message={errorFor(`items.${i}.quantity`)} />
                </label>
                <label className="grid content-start gap-1">
                  <span className="text-xs text-muted sm:sr-only">Price ({draft.currency})</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className={`${field} ${border(`items.${i}.unit_amount`)} tabular-nums`}
                    value={it.unit_amount}
                    onChange={(e) => {
                      updateItem(i, { unit_amount: Number(e.target.value) });
                      touch(`items.${i}.unit_amount`);
                    }}
                    onBlur={() => touch(`items.${i}.unit_amount`)}
                  />
                  <FieldError message={errorFor(`items.${i}.unit_amount`)} />
                </label>
                <button type="button" aria-label={`Remove item ${i + 1}`} disabled={draft.items.length <= 1} onClick={() => removeItem(i)} className={`${removeBtn} hidden sm:grid`}>
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={() => update({ items: [...draft.items, { name: "", quantity: 1, unit_amount: 0 }] })} className="w-fit text-sm font-medium text-cleared">
              + Add line
            </button>
          </div>

          {reviewEnabled && (
            <ReviewPanel
              currency={draft.currency}
              items={draft.items}
              // A blank first line is replaced rather than left empty above the suggestion.
              onAddItem={(item) => update({ items: [...draft.items.filter((it) => it.name.trim() || it.unit_amount), item] })}
            />
          )}

          <fieldset className="grid gap-3">
            <legend className="mb-2 text-sm text-muted">How will the client pay?</legend>
            <div role="radiogroup" aria-label="How will the client pay?" className="flex w-fit overflow-hidden rounded-lg border border-line text-sm">
              {PAY_MODES.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={payMode === m.id} onClick={() => choosePayMode(m.id)} className={`px-4 py-2 ${payMode === m.id ? "bg-ink text-white" : ""}`}>
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted">{PAY_MODES.find((m) => m.id === payMode)!.hint}</p>
            {payMode === "milestones" && (
              <div className="grid gap-2">
                <div className="hidden grid-cols-[1fr_7rem_10rem_2rem] gap-2 text-xs font-medium uppercase tracking-wide text-muted sm:grid">
                  <span>Milestone</span>
                  <span>Amount ({draft.currency})</span>
                  <span>Due date</span>
                  <span aria-hidden />
                </div>
                {parts.map((p, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_2rem] gap-x-2 gap-y-1 border-b border-line pb-2 sm:grid-cols-[1fr_7rem_10rem_2rem] sm:border-0 sm:pb-0">
                    <label className="col-span-2 grid content-start gap-1 sm:col-span-1">
                      <span className="text-xs text-muted sm:sr-only">Milestone</span>
                      <input
                        dir="auto"
                        className={`${field} ${border(`parts.${i}.name`)}`}
                        value={p.name}
                        onChange={(e) => {
                          updatePart(i, { name: e.target.value });
                          touch(`parts.${i}.name`);
                        }}
                        onBlur={() => touch(`parts.${i}.name`)}
                      />
                      <FieldError message={errorFor(`parts.${i}.name`)} />
                    </label>
                    <button type="button" aria-label={`Remove milestone ${i + 1}`} disabled={parts.length <= 2} onClick={() => removePart(i)} className={`${removeBtn} mt-5 sm:hidden`}>
                      ×
                    </button>
                    <label className="grid content-start gap-1">
                      <span className="text-xs text-muted sm:sr-only">Amount ({draft.currency})</span>
                      <input
                        type="number"
                        min={0}
                        max={capPartAmount(parts, i, total, total)}
                        step="0.01"
                        className={`${field} ${border(`parts.${i}.amount`)} tabular-nums`}
                        value={p.amount}
                        onChange={(e) => {
                          // Never more than the other milestones leave of the invoice total.
                          updatePart(i, { amount: capPartAmount(parts, i, Number(e.target.value), total) });
                          touch(`parts.${i}.amount`);
                        }}
                        onBlur={() => touch(`parts.${i}.amount`)}
                      />
                      <FieldError message={errorFor(`parts.${i}.amount`)} />
                    </label>
                    <label className="grid content-start gap-1">
                      <span className="text-xs text-muted sm:sr-only">Due date</span>
                      <input
                        type="date"
                        min={todayIso}
                        className={`${field} ${border(`parts.${i}.due_date`)} tabular-nums`}
                        value={p.due_date}
                        onChange={(e) => {
                          updatePart(i, { due_date: e.target.value });
                          touch(`parts.${i}.due_date`);
                        }}
                        onBlur={() => touch(`parts.${i}.due_date`)}
                      />
                      <FieldError message={errorFor(`parts.${i}.due_date`)} />
                    </label>
                    <button type="button" aria-label={`Remove milestone ${i + 1}`} disabled={parts.length <= 2} onClick={() => removePart(i)} className={`${removeBtn} hidden sm:grid`}>
                      ×
                    </button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <button type="button" disabled={parts.length >= 12} onClick={addPart} className="font-medium text-cleared disabled:opacity-40">
                    + Add milestone
                  </button>
                  <button type="button" onClick={() => setParts(splitEvenly(parts, total))} className="text-muted hover:underline">
                    Split evenly
                  </button>
                  <span className={`ms-auto tabular-nums ${check.errors.parts_total ? "font-semibold text-pending" : "text-muted"}`}>
                    {check.errors.parts_total ?? `${money(total, draft.currency)} in ${parts.length} milestones · fully assigned`}
                  </span>
                </div>
              </div>
            )}
          </fieldset>

          <div className={`grid gap-4 ${payMode === "full" ? "sm:grid-cols-[13rem_8rem_1fr]" : "sm:grid-cols-[13rem_1fr]"}`}>
            <label className="grid content-start gap-1.5 text-sm">
              <span className="text-muted">Currency</span>
              <select
                className={`${field} ${border("currency")}`}
                value={draft.currency}
                onChange={(e) => {
                  update({ currency: e.target.value });
                  touch("currency");
                }}
              >
                {!PAYPAL_CURRENCIES.some((c) => c.code === draft.currency) && <option value={draft.currency}>{draft.currency} (PayPal can&apos;t invoice in this)</option>}
                {PAYPAL_CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
              <FieldError message={errorFor("currency")} />
            </label>
            {payMode === "full" && (
              <label className="grid content-start gap-1.5 text-sm">
                <span className="text-muted">Due in (days)</span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  className={`${field} ${border("due_in_days")} tabular-nums`}
                  value={draft.due_in_days}
                  onChange={(e) => {
                    update({ due_in_days: Math.trunc(Number(e.target.value)) });
                    touch("due_in_days");
                  }}
                />
                <FieldError message={errorFor("due_in_days")} />
              </label>
            )}
            <label className="grid content-start gap-1.5 text-sm">
              <span className="text-muted">Note to client (optional)</span>
              <input dir="auto" className={`${field} border-line`} value={draft.note} onChange={(e) => update({ note: e.target.value })} />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <button type="button" onClick={send} disabled={busy !== null || !check.valid} className="rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
              {busy === "send"
                ? "Saving…"
                : payMode === "full"
                  ? `Send ${money(total, draft.currency)} invoice with PayPal`
                  : `Create ${parts.length}-milestone schedule for approval`}
            </button>
            <button type="button" onClick={reset} className="text-sm text-muted hover:underline">
              Discard draft
            </button>
            {!check.valid && !touched.has("*") && (
              <button type="button" onClick={() => setTouched(new Set(["*"]))} className="text-xs text-pending hover:underline">
                What&apos;s missing?
              </button>
            )}
          </div>
          <p className="text-xs text-muted">
            {payMode === "full"
              ? `Sent from ${freelancerName}. The invoice includes a link that lets the client connect their AI assistant to pay it.`
              : "Your client approves every date and amount first. With auto-pay on, each milestone is charged on its date unless they mark it “Not done yet”."}
          </p>
        </section>
      )}
    </div>
  );
}
