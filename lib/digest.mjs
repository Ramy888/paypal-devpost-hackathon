// The payback digest: what CollectPilot collected or created in a window, each dollar
// tied to the action that logged it (a PayPal capture, a sent reminder, a subscription).
import { toRow, isoDay } from "./invoices.mjs";
import { AGENT_NOTE_PREFIX, AUTOPAY_NOTE_PREFIX } from "./agentPay.mjs";

export { AGENT_NOTE_PREFIX };

const day = (d) => isoDay(new Date(d).getTime());
const sum = (items, key = "amount") => Math.round(items.reduce((t, i) => t + i[key], 0) * 100) / 100;

/**
 * Pure: no I/O. `invoices` are PayPal invoice details (with payments.transactions).
 * @param {{ invoices: object[], reminders: object[], retainers: object[], from: Date, to: Date, planPrice: number }} input
 */
export function buildDigest({ invoices, reminders, retainers, from, to, planPrice }) {
  const fromDay = day(from);
  const toDay = day(to);
  const sentReminder = new Map();
  for (const r of reminders) {
    if (r.status !== "sent" || !r.sentAt) continue;
    const prev = sentReminder.get(r.invoiceId);
    if (!prev || day(r.sentAt) < day(prev.sentAt)) sentReminder.set(r.invoiceId, r);
  }

  const byAgent = [];
  const byAutopay = [];
  const afterReminder = [];
  const other = [];
  const atRisk = [];
  for (const inv of invoices) {
    const row = toRow(inv, to);
    const base = { invoiceId: row.id, invoiceNumber: row.invoice_number, client: row.client, currency: row.currency };
    for (const t of inv.payments?.transactions ?? []) {
      const date = t.payment_date;
      if (!date || date < fromDay || date > toDay) continue;
      const item = { ...base, amount: Number(t.amount?.value ?? 0), date };
      const reminder = sentReminder.get(inv.id);
      if ((t.note ?? "").startsWith(AGENT_NOTE_PREFIX)) {
        byAgent.push({ ...item, evidence: t.note.slice(AGENT_NOTE_PREFIX.length).trim() });
      } else if ((t.note ?? "").startsWith(AUTOPAY_NOTE_PREFIX)) {
        // The " · schedule part <id>" tag is for matching charges to parts, not for people.
        const capture = t.note.slice(AUTOPAY_NOTE_PREFIX.length).replace(/ · schedule part \S+$/, "").trim();
        byAutopay.push({ ...item, evidence: `Milestone · ${capture}` });
      } else if (reminder && day(reminder.sentAt) <= date) {
        afterReminder.push({ ...item, evidence: `Reminder sent ${day(reminder.sentAt)}` });
      } else {
        other.push(item);
      }
    }
    if (row.risk === "high") atRisk.push({ ...base, amount: row.amount_due, evidence: `${row.days_overdue} days overdue` });
  }

  const active = retainers
    .filter((r) => r.status === "active")
    .map((r) => ({ client: r.clientName || r.clientEmail, amount: r.amount, currency: r.currency, evidence: `PayPal subscription ${r.subscriptionId}` }));
  const recurring = { monthly: sum(active), items: active };

  const value = sum([{ amount: sum(byAgent) }, { amount: sum(byAutopay) }, { amount: sum(afterReminder) }, { amount: recurring.monthly }]);
  return {
    from: fromDay,
    to: toDay,
    currency: invoices[0]?.amount?.currency_code ?? retainers[0]?.currency ?? "USD",
    byAgent: { total: sum(byAgent), items: byAgent },
    byAutopay: { total: sum(byAutopay), items: byAutopay },
    afterReminder: { total: sum(afterReminder), items: afterReminder },
    other: { total: sum(other), items: other },
    atRisk: { total: sum(atRisk), items: atRisk },
    recurring,
    value,
    planPrice,
    multiple: planPrice > 0 ? Math.floor(value / planPrice) : 0,
  };
}
