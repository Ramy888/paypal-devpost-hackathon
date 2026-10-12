"use client";

import { useRef, useState } from "react";

type Proposal = { invoice_id: string; invoice_number: string; amount: string; currency: string; full: boolean };
type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; proposals: Proposal[] }
  | { role: "error"; text: string };
type PayState = { state: "idle" | "paying" | "paid" | "failed"; note?: string };

const SUGGESTIONS = ["What do I owe?", "Pay everything that's overdue", "Which milestones are coming up?"];
const money = (v: string | number, c: string) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(Number(v));
  } catch {
    return `${v} ${c}`;
  }
};

// Reads the NDJSON reply: progress steps, then the finished turn (or an error).
async function readTurn(stream: ReadableStream<Uint8Array>, onStep: (s: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.type === "step") onStep(msg.step);
      else return msg;
    }
  }
  return { error: "The answer was cut off. Try again." };
}

// The client's chat with their hosted payments assistant. The API history (Claude's own message
// blocks) is kept as-is and sent back each turn; payments only happen through the Confirm buttons.
export function Chat({ freelancer }: { freelancer: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [pays, setPays] = useState<Record<string, PayState>>({});
  // Payments confirmed since the assistant last replied; sent with the next message so it knows.
  const [confirmed, setConfirmed] = useState<{ invoice_number: string; amount: string; currency: string; capture: string }[]>([]);
  const end = useRef<HTMLDivElement>(null);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setTurns((t) => [...t, { role: "user", text: q }]);
    setText("");
    setBusy(true);
    setStep("");
    try {
      const res = await fetch("/connect/assistant/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: q, history, confirmed }) });
      const body = res.ok && res.body ? await readTurn(res.body, setStep) : await res.json();
      if (!res.ok || body.error) throw new Error(body.error);
      setHistory(body.history);
      setConfirmed([]);
      setTurns((t) => [...t, { role: "assistant", text: body.reply, proposals: body.proposals ?? [] }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "error", text: (e as Error).message || "Something went wrong. Try again." }]);
    } finally {
      setBusy(false);
      setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
    }
  }

  async function confirm(p: Proposal, key: string) {
    setPays((s) => ({ ...s, [key]: { state: "paying" } }));
    try {
      const res = await fetch("/connect/assistant/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoice_id: p.invoice_id, amount: p.full ? null : Number(p.amount) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setPays((s) => ({ ...s, [key]: { state: "paid", note: `PayPal capture ${body.paypal_capture_id}` } }));
      setConfirmed((c) => [...c, { invoice_number: p.invoice_number, amount: String(body.amount), currency: p.currency, capture: body.paypal_capture_id }]);
    } catch (e) {
      setPays((s) => ({ ...s, [key]: { state: "failed", note: (e as Error).message } }));
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid min-h-[16rem] content-start gap-3 rounded-xl border border-line bg-card p-4 sm:p-5" aria-live="polite">
        {turns.length === 0 && (
          <div className="grid gap-3 text-sm text-muted">
            <p>Ask about what you owe {freelancer}, or tell me what to pay. I&apos;ll set payments up; you confirm each one.</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => ask(s)} className="rounded-full border border-line px-3 py-1.5 text-ink hover:border-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <p key={i} dir="auto" className="max-w-[85%] justify-self-end rounded-2xl rounded-br-sm bg-ink px-4 py-2 text-sm text-white">
              {t.text}
            </p>
          ) : t.role === "error" ? (
            <p key={i} role="alert" className="max-w-[85%] rounded-lg border border-pending/30 bg-pending-soft px-4 py-2 text-sm text-pending">
              {t.text}
            </p>
          ) : (
            <div key={i} className="grid max-w-[90%] gap-2">
              <p dir="auto" className="whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-paper px-4 py-2 text-sm leading-relaxed">
                {t.text}
              </p>
              {t.proposals.map((p, j) => {
                const key = `${i}-${j}`;
                const pay = pays[key] ?? { state: "idle" };
                return (
                  <div key={key} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold tabular-nums">
                        Pay {money(p.amount, p.currency)} {p.full ? "" : "(part)"}
                      </p>
                      <p className="truncate font-mono text-xs text-muted">{p.invoice_number}</p>
                    </div>
                    {pay.state === "paid" ? (
                      <span className="rounded-full bg-cleared-soft px-3 py-1 text-xs font-semibold text-cleared">Paid · {pay.note}</span>
                    ) : (
                      <button
                        type="button"
                        disabled={pay.state === "paying"}
                        onClick={() => confirm(p, key)}
                        className="rounded-md bg-cleared px-4 py-2 font-semibold text-white disabled:opacity-50"
                      >
                        {pay.state === "paying" ? "Paying…" : "Confirm"}
                      </button>
                    )}
                    {pay.state === "failed" && <p className="w-full text-xs text-pending">{pay.note}</p>}
                  </div>
                );
              })}
            </div>
          ),
        )}
        {busy && (
          <p role="status" className="text-sm text-muted">
            {step || "Sending"}…
          </p>
        )}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
        className="flex gap-2"
      >
        <input
          id="assistant-input"
          dir="auto"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          placeholder="Ask your assistant…"
          aria-label="Ask your assistant"
          className="min-w-0 flex-1 rounded-lg border border-line bg-card px-4 py-3"
        />
        <button disabled={busy || !text.trim()} className="rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
          Send
        </button>
      </form>
    </div>
  );
}
