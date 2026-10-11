"use client";

import { useState } from "react";
import { SOURCES, SOURCE_LABELS, MAX_SOURCE_CHARS } from "@/lib/reviewSources.mjs";

// "Check against what was agreed": the freelancer pastes the quote, client messages and notes, and
// gets per-line findings with quotes. Advice only: nothing is edited or sent from here, except a
// suggested line the freelancer chooses to add.

type Item = { name: string; quantity: number; unit_amount: number };
type Source = (typeof SOURCES)[number];
type Evidence = { source: Source; excerpt: string };
type Finding = { line: number; category: string; explanation: string; evidence: Evidence[]; question: string; by: "ai" | "check" };
type Suggested = { name: string; unit_amount: number | null; reason: string; evidence: Evidence[] };
type Review = { findings: Finding[]; suggested_items: Suggested[]; missing_information: string[]; dropped: number };

const CATEGORY: Record<string, { label: string; tone: "ok" | "warn" | "info" }> = {
  supported: { label: "Matches what was agreed", tone: "ok" },
  price_not_approved: { label: "No price approval found", tone: "warn" },
  possible_omission: { label: "Possibly not billed", tone: "info" },
  possible_duplicate: { label: "Possible duplicate", tone: "warn" },
  rate_or_currency_mismatch: { label: "Rate or currency differs", tone: "warn" },
  insufficient_evidence: { label: "Not enough to go on", tone: "info" },
};
const TONE = {
  ok: "bg-cleared-soft text-cleared",
  warn: "bg-pending-soft text-pending",
  info: "bg-line text-ink",
};

const PLACEHOLDER: Record<Source, string> = {
  quote: "Paste the quote or scope you agreed, e.g. “Website build: $600, including hosting for the first year.”",
  messages: "Paste the client messages that matter, e.g. “Could you also add a booking feature?”",
  notes: "Your own notes on what you did.",
};

export function ReviewPanel({ currency, items, onAddItem }: { currency: string; items: Item[]; onAddItem: (item: Item) => void }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<Record<Source, string>>({ quote: "", messages: "", notes: "" });
  const [review, setReview] = useState<Review | null>(null);
  const [reviewedKey, setReviewedKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());

  // Any change to the lines, currency or pasted text makes the last check out of date.
  const key = JSON.stringify({ currency, items, context });
  const stale = review !== null && key !== reviewedKey;
  const hasContext = SOURCES.some((s) => context[s].trim());

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/invoices/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft: { currency, items }, context }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setReview(body);
      setReviewedKey(key);
      setAdded(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const lineName = (line: number) => (line === 0 ? "Whole invoice" : `Line ${line} · ${items[line - 1]?.name || "(unnamed)"}`);
  const field = "w-full min-w-0 rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink";

  return (
    <section className="grid gap-3 rounded-lg border border-line bg-paper p-4" aria-label="Check against what was agreed">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center justify-between gap-3 text-start">
        <span className="grid gap-0.5">
          <span className="text-sm font-semibold">Check against what was agreed</span>
          <span className="text-xs text-muted">Optional. Paste the quote or client messages and AI checks each line before you send.</span>
        </span>
        <span aria-hidden className="text-muted">
          {open ? "−" : "+"}
        </span>
      </button>

      {open && (
        <div className="grid gap-3">
          {SOURCES.map((s) => (
            <label key={s} className="grid gap-1 text-sm">
              <span className="text-muted">{SOURCE_LABELS[s]}</span>
              <textarea
                dir="auto"
                rows={s === "notes" ? 2 : 3}
                maxLength={MAX_SOURCE_CHARS}
                value={context[s]}
                onChange={(e) => setContext({ ...context, [s]: e.target.value })}
                placeholder={PLACEHOLDER[s]}
                className={field}
              />
            </label>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={check}
              disabled={busy || !hasContext || !items.some((it) => it.name.trim())}
              className="rounded-lg border border-ink px-4 py-2 text-sm font-semibold disabled:opacity-40"
            >
              {busy ? "Checking…" : review ? "Check again" : "Check invoice"}
            </button>
            <span className="text-xs text-muted">Only you see this. Nothing is changed or sent.</span>
          </div>
          {error && (
            <p role="alert" className="text-sm text-pending">
              {error}
            </p>
          )}

          {stale && (
            <p role="status" className="text-xs font-semibold text-pending">
              You changed the invoice or the pasted text. Check again to update this.
            </p>
          )}
          {review && (
            <div className={`grid gap-3 ${stale ? "opacity-50" : ""}`} aria-live="polite">
              {review.findings.length === 0 && review.suggested_items.length === 0 && (
                <p className="text-sm text-muted">Nothing to flag in what you pasted.</p>
              )}
              <ul className="grid gap-2">
                {review.findings.map((f, i) => {
                  const c = CATEGORY[f.category] ?? CATEGORY.insufficient_evidence;
                  return (
                    <li key={i} className="grid gap-1.5 rounded-md border border-line bg-card p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[c.tone]}`}>{c.label}</span>
                        <span className="text-xs text-muted">{lineName(f.line)}</span>
                      </div>
                      <p dir="auto" className="text-sm">
                        {f.explanation}
                      </p>
                      {f.evidence.map((e, j) => (
                        <blockquote key={j} dir="auto" className="border-s-2 border-line ps-3 text-xs text-muted">
                          “{e.excerpt}” <span className="whitespace-nowrap">— {SOURCE_LABELS[e.source]}</span>
                        </blockquote>
                      ))}
                      {f.question && (
                        <p dir="auto" className="text-xs">
                          <span className="font-semibold">Ask the client:</span> {f.question}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>

              {review.suggested_items.length > 0 && (
                <div className="grid gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Maybe not billed yet</p>
                  {review.suggested_items.map((s, i) => (
                    <div key={i} className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-dashed border-line p-3">
                      <div className="grid min-w-0 gap-1">
                        <p dir="auto" className="text-sm font-medium">
                          {s.name}
                          {s.unit_amount !== null && <span className="text-muted"> · {s.unit_amount} {currency}</span>}
                        </p>
                        <p dir="auto" className="text-xs text-muted">
                          {s.reason}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={added.has(i) || stale}
                        onClick={() => {
                          onAddItem({ name: s.name, quantity: 1, unit_amount: s.unit_amount ?? 0 });
                          setAdded(new Set(added).add(i));
                        }}
                        className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                      >
                        {added.has(i) ? "Added: check the price" : "Add as a line"}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {review.missing_information.length > 0 && (
                <div className="grid gap-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Worth confirming</p>
                  <ul className="list-disc ps-5 text-sm">
                    {review.missing_information.map((q, i) => (
                      <li key={i} dir="auto">
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="text-xs text-muted">
                Based only on what you pasted, so it can miss things. You decide what to change.
                {review.dropped > 0 && ` ${review.dropped} point${review.dropped === 1 ? " was" : "s were"} left out because the quote wasn't in your text.`}
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
