// Maps PayPal invoices and webhook summaries to receivables-grid rows.

const PAID = new Set(["PAID", "MARKED_AS_PAID"]);
const DAY_MS = 86_400_000;

export const isPaid = (status) => PAID.has(status);

export function daysOverdue(dueDate, status, now = new Date()) {
  if (!dueDate || isPaid(status)) return 0;
  const days = Math.floor((now.getTime() - Date.parse(`${dueDate}T00:00:00Z`)) / DAY_MS);
  return Math.max(0, days);
}

export function toRow(inv, now = new Date()) {
  const dueDate = inv.detail?.payment_term?.due_date ?? null;
  return {
    id: inv.id,
    invoice_number: inv.detail?.invoice_number ?? inv.id,
    client: inv.primary_recipients?.[0]?.billing_info?.email_address ?? "",
    amount: Number(inv.amount?.value ?? 0),
    currency: inv.amount?.currency_code ?? "USD",
    status: inv.status,
    paid: isPaid(inv.status),
    due_date: dueDate ?? "",
    days_overdue: daysOverdue(dueDate, inv.status, now),
  };
}

// Applies a webhook summary: updates the matching row, or adds a new one.
export function applyEvent(rows, ev, now = new Date()) {
  if (!ev.invoice_id) return rows;
  const i = rows.findIndex((r) => r.id === ev.invoice_id);
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
  const next = {
    ...prev,
    status: ev.status ?? prev.status,
    paid: isPaid(ev.status ?? prev.status),
    days_overdue: daysOverdue(prev.due_date, ev.status ?? prev.status, now),
  };
  return rows.with(i, next);
}
