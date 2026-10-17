// Maps PayPal invoices and webhook summaries to receivables-grid rows.

const PAID = new Set(["PAID", "MARKED_AS_PAID"]);
const DAY_MS = 86_400_000;

export const isPaid = (status) => PAID.has(status);
// Statuses where money is still owed. Drafts, cancelled, refunded and scheduled invoices are not receivables.
export const UNPAID = ["SENT", "UNPAID", "PARTIALLY_PAID"];

export function daysOverdue(dueDate, status, now = new Date()) {
  if (!dueDate || isPaid(status)) return 0;
  const days = Math.floor((now.getTime() - Date.parse(`${dueDate}T00:00:00Z`)) / DAY_MS);
  return Math.max(0, days);
}

/** Deterministic 3-bucket risk, with a one-line reason the freelancer can read. */
export function riskOf({ days, amount }) {
  if (days >= 14 || (days >= 7 && amount >= 2000)) return { bucket: "high", reason: `${days} days overdue on ${amount.toFixed(2)}; payment is at risk.` };
  if (days >= 7 || amount >= 1000) return { bucket: "medium", reason: `${days} days overdue; a firmer follow-up usually works now.` };
  return { bucket: "low", reason: `Only ${days} day${days === 1 ? "" : "s"} overdue; most clients pay after a friendly nudge.` };
}

// Days after the due date (or after today, once overdue) we expect payment, by risk.
// A rule of thumb, not a forecast model: the plan cut 30/60/90 forecasting on purpose.
const PAY_LAG_DAYS = { low: 3, medium: 7, high: 21 };
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function expectedPayDate({ dueDate, paid, days, bucket, now = new Date() }) {
  if (paid || !dueDate) return "";
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  if (days > 0) return isoDay(Date.parse(`${isoDay(now.getTime())}T00:00:00Z`) + PAY_LAG_DAYS[bucket] * DAY_MS);
  return isoDay(due);
}

// Risk, expected date and the per-row amounts the cash-panel tiles sum. Recomputed on every status change.
function deriveRow(row, now) {
  if (!UNPAID.includes(row.status)) return { ...row, risk: "", expected_pay_date: "", outstanding: 0, overdue_amount: 0, expected_7d: 0, at_risk: 0 };
  // The client marked this part "Not done yet": still owed, but not late and not chased.
  if (row.held) return { ...row, days_overdue: 0, risk: "on hold", expected_pay_date: "", outstanding: row.amount_due, overdue_amount: 0, expected_7d: 0, at_risk: 0 };
  // riskOf scores overdue invoices; one that isn't due yet hasn't had a chance to be late.
  const bucket = row.days_overdue > 0 ? riskOf({ days: row.days_overdue, amount: row.amount_due }).bucket : "low";
  const expected = expectedPayDate({ dueDate: row.due_date, paid: false, days: row.days_overdue, bucket, now });
  const weekOut = isoDay(now.getTime() + 7 * DAY_MS);
  return {
    ...row,
    risk: bucket,
    expected_pay_date: expected,
    outstanding: row.amount_due,
    overdue_amount: row.days_overdue > 0 ? row.amount_due : 0,
    expected_7d: expected && expected <= weekOut ? row.amount_due : 0,
    at_risk: bucket === "high" ? row.amount_due : 0,
  };
}

// What the receivables table shows as the client: PayPal's recipient name, else the business,
// else the part of the email before the @ (the full email stays in `client`).
function clientName(billing) {
  const n = billing?.name;
  const person = n?.full_name || [n?.given_name, n?.surname].filter(Boolean).join(" ");
  const local = (billing?.email_address ?? "").split("@")[0];
  // PayPal sandbox buyers are "sb-<random>@personal.example.com": no one reads that as a name.
  return person || billing?.business_name || (/^sb-[a-z0-9]+$/i.test(local) ? "Sandbox buyer" : local);
}

const CLOSED = ["CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"];
const rank = (r) => (r.held ? 0 : !r.paid && !CLOSED.includes(r.status) ? (r.days_overdue > 0 ? 1 : 2) : CLOSED.includes(r.status) ? 4 : 3);

/** Rows in the order that needs attention: held, overdue (most first), unpaid by due date, then paid (newest first), then cancelled. */
export function byAttention(rows) {
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d) return d;
    if (rank(a) === 1) return b.days_overdue - a.days_overdue;
    if (rank(a) === 2) return a.due_date.localeCompare(b.due_date);
    return b.due_date.localeCompare(a.due_date);
  });
}

// `schedule` (optional): this invoice's entry from scheduleOverrides (project label, hold, real due date).
export function toRow(inv, now = new Date(), schedule = null) {
  const dueDate = schedule?.dueDate ?? inv.detail?.payment_term?.due_date ?? null;
  return deriveRow(
    {
      id: inv.id,
      invoice_number: inv.detail?.invoice_number ?? inv.id,
      client: inv.primary_recipients?.[0]?.billing_info?.email_address ?? "",
      client_name: clientName(inv.primary_recipients?.[0]?.billing_info),
      amount: Number(inv.amount?.value ?? 0),
      amount_due: Number(inv.due_amount?.value ?? inv.amount?.value ?? 0),
      currency: inv.amount?.currency_code ?? "USD",
      status: inv.status,
      paid: isPaid(inv.status),
      due_date: dueDate ?? "",
      days_overdue: daysOverdue(dueDate, inv.status, now),
      project: schedule?.project ?? "",
      held: Boolean(schedule?.held),
    },
    now,
  );
}

export const SCHEDULE_EVENT = "APP.SCHEDULE.UPDATED";

// Applies a webhook summary: updates the matching row, or adds a new one.
export function applyEvent(rows, ev, now = new Date()) {
  if (!ev.invoice_id) return rows;
  const i = rows.findIndex((r) => r.id === ev.invoice_id);
  // A client's "Not done yet" (or its end) on a schedule part: only the hold changes.
  if (ev.event_type === SCHEDULE_EVENT) {
    if (i === -1) return rows;
    const prev = rows[i];
    return rows.with(i, deriveRow({ ...prev, held: Boolean(ev.held), days_overdue: daysOverdue(prev.due_date, prev.status, now) }, now));
  }
  if (i === -1) {
    const row = toRow(
      {
        id: ev.invoice_id,
        status: ev.status,
        amount: { value: ev.amount, currency_code: ev.currency },
        detail: { invoice_number: ev.invoice_number, payment_term: { due_date: ev.due_date } },
        primary_recipients: [{ billing_info: { email_address: ev.client } }],
      },
      now,
    );
    return [row, ...rows];
  }
  const prev = rows[i];
  const next = deriveRow(
    {
      ...prev,
      status: ev.status ?? prev.status,
      paid: isPaid(ev.status ?? prev.status),
      days_overdue: daysOverdue(prev.due_date, ev.status ?? prev.status, now),
    },
    now,
  );
  return rows.with(i, next);
}
