import { test } from "node:test";
import assert from "node:assert/strict";
import { planReminders, riskOf, isArabic, tick, sendReminder, AUTO_SEND_AFTER_MS } from "../lib/reminders.mjs";

const NOW = new Date("2026-10-20T12:00:00Z");
const inv = (id, dueDate, over = {}) => ({
  id,
  status: "SENT",
  amount: { value: "500.00", currency_code: "USD" },
  detail: { invoice_number: `RVS-${id}`, note: "Thanks!", payment_term: { due_date: dueDate } },
  primary_recipients: [{ billing_info: { email_address: "c@x.com", business_name: "Acme" } }],
  ...over,
});

test("stages follow days overdue: 1 → nudge, 7 → follow-up, 14 → final", () => {
  const plans = planReminders({
    invoices: [inv("A", "2026-10-18"), inv("B", "2026-10-12"), inv("C", "2026-10-05"), inv("D", "2026-10-25")],
    existing: [],
    now: NOW,
  });
  const byId = Object.fromEntries(plans.map((p) => [p.invoice.id, p.stage]));
  assert.deepEqual(byId, { A: 1, B: 2, C: 3 }); // D is not due yet
});

test("paid or cancelled invoices are never planned, and a stage is never drafted twice", () => {
  const plans = planReminders({
    invoices: [inv("A", "2026-10-18", { status: "PAID" }), inv("B", "2026-10-18", { status: "CANCELLED" }), inv("C", "2026-10-18")],
    existing: [{ invoiceId: "C", stage: 1 }],
    now: NOW,
  });
  assert.equal(plans.length, 0);
});

test("risk buckets are deterministic and explained", () => {
  assert.equal(riskOf({ days: 2, amount: 300 }).bucket, "low");
  assert.equal(riskOf({ days: 8, amount: 300 }).bucket, "medium");
  assert.equal(riskOf({ days: 15, amount: 300 }).bucket, "high");
  assert.match(riskOf({ days: 2, amount: 300 }).reason, /2 days overdue/);
});

test("Arabic is detected from the invoice text", () => {
  assert.equal(isArabic("شكراً لتعاملكم"), true);
  assert.equal(isArabic("Thanks!"), false);
});

// In-memory store and fakes for a full autopilot pass.
function memoryStore() {
  const rows = [];
  return {
    rows,
    listReminderKeys: async () => rows.map((r) => ({ invoiceId: r.invoiceId, stage: r.stage })),
    async insertReminder(r) {
      if (rows.some((x) => x.invoiceId === r.invoiceId && x.stage === r.stage)) return false;
      rows.push({ id: `r${rows.length + 1}`, status: "drafted", ...r });
      return true;
    },
    remindersDue: async (now) => rows.filter((r) => r.status === "drafted" && r.autoSendAt <= now),
    async markReminderSent(id, by) {
      Object.assign(rows.find((r) => r.id === id), { status: "sent", sentBy: by });
    },
    async cancelReminder(id) {
      rows.find((r) => r.id === id).status = "cancelled";
    },
  };
}
function fakePayPal(invoices) {
  const calls = [];
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (path.startsWith("/v2/invoicing/search-invoices")) return { items: invoices };
      if (method === "GET") return invoices.find((i) => path.endsWith(i.id));
      if (path.endsWith("/remind")) return {};
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}
function fakeAnthropic() {
  const calls = [];
  return {
    calls,
    messages: {
      async parse(req) {
        calls.push(req);
        return { stop_reason: "end_turn", parsed_output: { subject: "Friendly reminder", body: "Hi, a quick nudge about the invoice." } };
      },
    },
  };
}
const deps = (invoices, over = {}) => ({
  paypal: fakePayPal(invoices),
  anthropic: fakeAnthropic(),
  store: memoryStore(),
  model: "claude-opus-5-5",
  freelancerName: "Ramy Video Editing Studio",
  appUrl: "https://app.test",
  ...over,
});

test("first pass drafts but does not send; a pass a day later sends what nobody touched", async () => {
  const d = deps([inv("A", "2026-10-18")]);
  const first = await tick({ ...d, now: NOW });
  assert.deepEqual(first, { planned: 1, drafted: 1, sent: 0 });
  assert.equal(d.paypal.calls.filter((c) => c.path.endsWith("/remind")).length, 0);

  const later = new Date(NOW.getTime() + AUTO_SEND_AFTER_MS);
  const second = await tick({ ...d, now: later });
  assert.equal(second.sent, 1);
  const remind = d.paypal.calls.find((c) => c.path.endsWith("/remind"));
  assert.equal(remind.body.subject, "Friendly reminder");
  assert.equal(remind.body.send_to_invoicer, true);
  assert.equal(d.store.rows[0].sentBy, "autopilot");
});

test("a cancelled reminder never sends", async () => {
  const d = deps([inv("A", "2026-10-18")]);
  await tick({ ...d, now: NOW });
  d.store.rows[0].status = "cancelled";
  const later = await tick({ ...d, now: new Date(NOW.getTime() + 2 * AUTO_SEND_AFTER_MS) });
  assert.equal(later.sent, 0);
  assert.equal(d.paypal.calls.filter((c) => c.path.endsWith("/remind")).length, 0);
});

test("an edited reminder sends the freelancer's text", async () => {
  const d = deps([inv("A", "2026-10-18")]);
  await tick({ ...d, now: NOW });
  d.store.rows[0].body = "Edited by Ramy";
  await tick({ ...d, now: new Date(NOW.getTime() + AUTO_SEND_AFTER_MS) });
  assert.equal(d.paypal.calls.find((c) => c.path.endsWith("/remind")).body.note, "Edited by Ramy");
});

test("AI drafting is capped per pass and stops when the spend guard says no", async () => {
  const many = Array.from({ length: 8 }, (_, i) => inv(`I${i}`, "2026-10-18"));
  const d = deps(many);
  const r = await tick({ ...d, now: NOW, maxDrafts: 3 });
  assert.equal(r.drafted, 3);
  assert.equal(d.anthropic.calls.length, 3);

  const d2 = deps(many);
  await tick({ ...d2, now: NOW, canSpend: () => false });
  assert.equal(d2.anthropic.calls.length, 0);
});

test("a reminder for an invoice paid in the meantime is cancelled, not sent", async () => {
  const invoices = [inv("A", "2026-10-18")];
  const d = deps(invoices);
  await tick({ ...d, now: NOW });
  invoices[0].status = "PAID";
  const sent = await sendReminder({ paypal: d.paypal, store: d.store, reminder: d.store.rows[0], by: "owner", now: NOW });
  assert.equal(sent, false);
  assert.equal(d.store.rows[0].status, "cancelled");
});

test("stage 2+ reminders include the agent payment link; stage 1 does not", async () => {
  const d = deps([inv("A", "2026-10-12"), inv("B", "2026-10-18")]);
  await tick({ ...d, now: NOW });
  const [stage2, stage1] = d.anthropic.calls.map((c) => c.messages[0].content);
  assert.match(stage2, /connect\?n=RVS-A/);
  assert.doesNotMatch(stage1, /connect\?n=/);
});

test("on the Free plan nothing is sent automatically, even when it is due", async () => {
  const d = deps([inv("A", "2026-10-18")]);
  await tick({ ...d, now: NOW });
  const later = await tick({ ...d, now: new Date(NOW.getTime() + AUTO_SEND_AFTER_MS), autoSend: false });
  assert.equal(later.sent, 0);
  assert.equal(d.paypal.calls.filter((c) => c.path.endsWith("/remind")).length, 0);
  assert.equal(d.store.rows[0].status, "drafted");
});

test("a send-only pass (background timer) never calls the AI", async () => {
  const d = deps([inv("A", "2026-10-18")]);
  const r = await tick({ ...d, now: NOW, draft: false });
  assert.equal(r.drafted, 0);
  assert.equal(d.anthropic.calls.length, 0);
});
