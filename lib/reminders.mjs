// The reminder agent: finds overdue invoices, drafts a reminder in the client's language,
// shows it to the freelancer, and sends it on schedule unless they edit or cancel it.
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { daysOverdue, riskOf, UNPAID } from "./invoices.mjs";

export { riskOf, UNPAID };

const DAY_MS = 86_400_000;

// Stage by days overdue: a friendly nudge, a firmer follow-up, then a final notice.
export const STAGES = [
  { stage: 1, minDays: 1, tone: "friendly nudge" },
  { stage: 2, minDays: 7, tone: "firmer follow-up; mention they can let their AI assistant pay automatically via the link" },
  { stage: 3, minDays: 14, tone: "final, polite but clear notice" },
];
export const AUTO_SEND_AFTER_MS = DAY_MS;

export const isArabic = (s) => /[؀-ۿ]/.test(s ?? "");

/**
 * Which reminders to draft now. Pure: no I/O.
 * `overrides` (optional): scheduleOverrides output. Held parts are skipped; schedule dates win.
 * @param {{ invoices: object[], existing: { invoiceId: string, stage: number }[], now: Date, overrides?: Map<string, { held: boolean, dueDate: string }> }} input
 */
export function planReminders({ invoices, existing, now, overrides = new Map() }) {
  const done = new Set(existing.map((r) => `${r.invoiceId}:${r.stage}`));
  const plans = [];
  for (const inv of invoices) {
    if (!UNPAID.includes(inv.status)) continue;
    const scheduled = overrides.get(inv.id);
    if (scheduled?.held) continue;
    const due = scheduled?.dueDate ?? inv.detail?.payment_term?.due_date;
    const days = daysOverdue(due, inv.status, now);
    if (days < 1) continue;
    const stage = [...STAGES].reverse().find((s) => days >= s.minDays);
    if (!stage || done.has(`${inv.id}:${stage.stage}`)) continue;
    const amount = Number((inv.due_amount ?? inv.amount)?.value ?? 0);
    plans.push({ invoice: inv, stage: stage.stage, tone: stage.tone, days, amount, risk: riskOf({ days, amount }) });
  }
  return plans.sort((a, b) => b.days - a.days);
}

const ReminderSchema = z.object({
  subject: z.string().describe("Email subject, under 80 characters."),
  body: z.string().describe("Plain-text email body, under 700 characters, no greeting placeholders."),
});

/** Drafts the reminder text with Claude. One call per reminder. */
export async function draftReminder({ anthropic, model, plan, freelancerName, connectLink }) {
  const inv = plan.invoice;
  const arabic = isArabic(inv.detail?.note) || isArabic(inv.primary_recipients?.[0]?.billing_info?.business_name);
  const amount = inv.due_amount ?? inv.amount;
  const facts = [
    `Freelancer: ${freelancerName}`,
    `Client: ${inv.primary_recipients?.[0]?.billing_info?.business_name ?? "the client"}`,
    `Invoice: ${inv.detail?.invoice_number}, ${amount?.value} ${amount?.currency_code}, ${plan.days} days overdue`,
    `Tone: ${plan.tone}`,
    `Write in: ${arabic ? "Arabic" : "English"}`,
    plan.stage >= 2 ? `Agent payment link: ${connectLink}` : "",
  ].filter(Boolean);

  const response = await anthropic.messages.parse({
    model,
    max_tokens: 1500,
    output_config: { effort: "low", format: zodOutputFormat(ReminderSchema) },
    system:
      "You write short, warm, professional payment reminders for a freelancer. Never threaten, never invent fees or deadlines, " +
      "never change the amount. PayPal adds the invoice and pay button below your text, so do not add links other than the one given.",
    messages: [{ role: "user", content: facts.join("\n") }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error("Could not draft the reminder.");
  return {
    subject: response.parsed_output.subject.slice(0, 120),
    body: response.parsed_output.body.slice(0, 900),
    language: arabic ? "ar" : "en",
  };
}

/**
 * One autopilot pass: draft new reminders (capped), then send the ones whose time has come.
 * Every dependency is injected so the whole pass is testable without PayPal, Claude or a database.
 */
export async function tick({ paypal, anthropic, store, now, model, freelancerName, appUrl, draft = true, autoSend = true, maxDrafts = 5, canSpend = () => true, overrides = new Map() }) {
  const res = await paypal.request("POST", "/v2/invoicing/search-invoices?page=1&page_size=100", { status: UNPAID });
  const invoices = res.items ?? [];
  const plans = planReminders({ invoices, existing: await store.listReminderKeys(), now, overrides });

  let drafted = 0;
  for (const plan of plans) {
    if (!draft || drafted >= maxDrafts || !canSpend()) break;
    const inv = plan.invoice;
    const connectLink = `${appUrl}/connect?n=${encodeURIComponent(inv.detail?.invoice_number ?? "")}`;
    const text = await draftReminder({ anthropic, model, plan, freelancerName, connectLink });
    const created = await store.insertReminder({
      invoiceId: inv.id,
      invoiceNumber: inv.detail?.invoice_number ?? inv.id,
      clientEmail: inv.primary_recipients?.[0]?.billing_info?.email_address ?? "",
      stage: plan.stage,
      daysOverdue: plan.days,
      amount: plan.amount,
      currency: (inv.due_amount ?? inv.amount)?.currency_code ?? "USD",
      riskBucket: plan.risk.bucket,
      riskReason: plan.risk.reason,
      language: text.language,
      subject: text.subject,
      body: text.body,
      draftedAt: now,
      autoSendAt: new Date(now.getTime() + AUTO_SEND_AFTER_MS),
    });
    if (created) drafted += 1; // false when another pass drafted the same stage first
  }

  // Free plan: drafts wait for the freelancer's approval; only Pro lets the autopilot send.
  let sent = 0;
  for (const r of autoSend ? await store.remindersDue(now) : []) {
    // The client marked this part "Not done yet" after the reminder was drafted.
    if (overrides.get(r.invoiceId)?.held) {
      await store.cancelReminder(r.id, "client marked it not done yet");
      continue;
    }
    await sendReminder({ paypal, store, reminder: r, by: "autopilot", now });
    sent += 1;
  }
  return { planned: plans.length, drafted, sent };
}

/** Sends one drafted reminder through PayPal (which emails the client and copies the freelancer). */
export async function sendReminder({ paypal, store, reminder, by, now }) {
  if (reminder.status !== "drafted") return false;
  const inv = await paypal.request("GET", `/v2/invoicing/invoices/${encodeURIComponent(reminder.invoiceId)}`);
  if (!UNPAID.includes(inv.status)) {
    await store.cancelReminder(reminder.id, "invoice already paid or closed");
    return false;
  }
  await paypal.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(reminder.invoiceId)}/remind`, {
    subject: reminder.subject,
    note: reminder.body,
    send_to_invoicer: true,
    send_to_recipient: true,
  });
  await store.markReminderSent(reminder.id, by, now);
  return true;
}
