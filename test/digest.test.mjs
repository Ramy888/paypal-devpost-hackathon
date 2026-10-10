import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest, AGENT_NOTE_PREFIX } from "../lib/digest.mjs";

const FROM = new Date("2026-10-14T00:00:00Z");
const TO = new Date("2026-10-21T12:00:00Z");

const invoice = (id, number, status, value, payments = [], due = "2026-10-10") => ({
  id,
  status,
  amount: { value, currency_code: "USD" },
  detail: { invoice_number: number, payment_term: { due_date: due } },
  primary_recipients: [{ billing_info: { email_address: "acme@example.com" } }],
  payments: { transactions: payments },
});
const tx = (date, value, note = "") => ({ payment_date: date, amount: { value, currency_code: "USD" }, note, payment_id: `EXTR-${date}-${value}` });

const INVOICES = [
  invoice("I1", "CP-1", "MARKED_AS_PAID", "320.00", [tx("2026-10-20", "320.00", `${AGENT_NOTE_PREFIX} PayPal capture CAP1 (order O1)`)]),
  invoice("I2", "CP-2", "PAID", "500.00", [tx("2026-10-19", "500.00")]),
  invoice("I3", "CP-3", "PAID", "90.00", [tx("2026-10-18", "90.00")]),
  invoice("I4", "CP-4", "PAID", "700.00", [tx("2026-10-01", "700.00", `${AGENT_NOTE_PREFIX} capture OLD`)]), // before the window
  invoice("I5", "CP-5", "SENT", "1500.00", [], "2026-09-30"), // 21 days overdue → high risk
  invoice("I6", "CP-6", "SENT", "200.00", [], "2026-10-19"), // 2 days overdue → low risk
];
const REMINDERS = [
  { invoiceId: "I2", invoiceNumber: "CP-2", status: "sent", sentAt: new Date("2026-10-17T09:00:00Z") },
  { invoiceId: "I3", invoiceNumber: "CP-3", status: "sent", sentAt: new Date("2026-10-19T09:00:00Z") }, // sent after the payment
  { invoiceId: "I6", invoiceNumber: "CP-6", status: "drafted", sentAt: null },
];
const RETAINERS = [
  { id: "R1", clientEmail: "acme@example.com", clientName: "Acme", amount: 280, currency: "USD", status: "active", subscriptionId: "I-SUB1" },
  { id: "R2", clientEmail: "b@example.com", clientName: "B", amount: 99, currency: "USD", status: "offered", subscriptionId: null },
];

const digest = () => buildDigest({ invoices: INVOICES, reminders: REMINDERS, retainers: RETAINERS, from: FROM, to: TO, planPrice: 12 });

test("money the client's agent paid in the window is tied to its PayPal capture", () => {
  const d = digest();
  assert.equal(d.byAgent.total, 320);
  assert.equal(d.byAgent.items.length, 1);
  assert.equal(d.byAgent.items[0].invoiceNumber, "CP-1");
  assert.match(d.byAgent.items[0].evidence, /CAP1/);
});

test("a payment after a sent reminder is credited to the reminder; one before it is not", () => {
  const d = digest();
  assert.equal(d.afterReminder.total, 500);
  assert.deepEqual(d.afterReminder.items.map((i) => i.invoiceNumber), ["CP-2"]);
  assert.match(d.afterReminder.items[0].evidence, /2026-10-17/);
  assert.equal(d.other.total, 90);
});

test("payments outside the window are left out", () => {
  const d = digest();
  assert.ok(!d.byAgent.items.some((i) => i.invoiceNumber === "CP-4"));
});

test("at risk lists unpaid high-risk invoices", () => {
  const d = digest();
  assert.equal(d.atRisk.total, 1500);
  assert.deepEqual(d.atRisk.items.map((i) => i.invoiceNumber), ["CP-5"]);
});

test("recurring counts only active retainers, by their subscription", () => {
  const d = digest();
  assert.equal(d.recurring.monthly, 280);
  assert.deepEqual(d.recurring.items.map((i) => i.evidence), ["PayPal subscription I-SUB1"]);
});

test("value credited to CollectPilot is agent + reminder + recurring, against the plan price", () => {
  const d = digest();
  assert.equal(d.value, 320 + 500 + 280);
  assert.equal(d.planPrice, 12);
  assert.equal(d.multiple, Math.floor((320 + 500 + 280) / 12));
});

test("an empty account gives zeros, not NaN", () => {
  const d = buildDigest({ invoices: [], reminders: [], retainers: [], from: FROM, to: TO, planPrice: 12 });
  assert.equal(d.value, 0);
  assert.equal(d.multiple, 0);
});

test("cancelled invoices are never at risk; partly paid ones count what is still due", () => {
  const d = buildDigest({
    invoices: [
      invoice("C1", "CP-C", "CANCELLED", "1500.00", [], "2026-09-30"),
      { ...invoice("P1", "CP-P", "PARTIALLY_PAID", "2500.00", [], "2026-09-30"), due_amount: { value: "400.00", currency_code: "USD" } },
    ],
    reminders: [], retainers: [], from: FROM, to: TO, planPrice: 12,
  });
  assert.deepEqual(d.atRisk.items.map((i) => [i.invoiceNumber, i.amount]), [["CP-P", 400]]);
});

test("auto-pay collections are credited separately, each tied to its PayPal capture", async () => {
  const { AUTOPAY_NOTE_PREFIX } = await import("../lib/agentPay.mjs");
  const d = buildDigest({
    invoices: [invoice("A1", "CP-A", "PARTIALLY_PAID", "3000.00", [tx("2026-10-20", "900.00", `${AUTOPAY_NOTE_PREFIX} PayPal capture CAPX (order OX)`)])],
    reminders: [], retainers: [], from: FROM, to: TO, planPrice: 12,
  });
  assert.equal(d.byAutopay.total, 900);
  assert.match(d.byAutopay.items[0].evidence, /CAPX/);
  assert.equal(d.byAgent.total, 0);
  assert.equal(d.value, 900);
});
