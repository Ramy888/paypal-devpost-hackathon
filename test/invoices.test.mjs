import { test } from "node:test";
import assert from "node:assert/strict";
import { toRow, applyEvent, daysOverdue, expectedPayDate, byAttention } from "../lib/invoices.mjs";

const NOW = new Date("2026-10-21T12:00:00Z");
const INVOICE = {
  id: "INV2-AAAA",
  status: "SENT",
  amount: { value: "1200.00", currency_code: "USD" },
  detail: { invoice_number: "CP-1", payment_term: { due_date: "2026-10-18" } },
  primary_recipients: [{ billing_info: { email_address: "acme@example.com" } }],
};

test("an unpaid invoice past its due date counts days overdue", () => {
  const row = toRow(INVOICE, NOW);
  assert.equal(row.days_overdue, 3);
  assert.equal(row.paid, false);
  assert.equal(row.amount, 1200);
});

test("paid invoices are never overdue", () => {
  assert.equal(daysOverdue("2026-10-18", "PAID", NOW), 0);
  assert.equal(daysOverdue("2026-10-18", "MARKED_AS_PAID", NOW), 0);
});

test("a PAID event flips the matching row and clears days overdue", () => {
  const rows = [toRow(INVOICE, NOW)];
  const next = applyEvent(rows, { invoice_id: "INV2-AAAA", status: "PAID" }, NOW);
  assert.equal(next[0].status, "PAID");
  assert.equal(next[0].paid, true);
  assert.equal(next[0].days_overdue, 0);
  assert.equal(rows[0].status, "SENT", "original rows are not mutated");
});

test("MARKED_AS_PAID (payment recorded through the API) also counts as paid", () => {
  const next = applyEvent([toRow(INVOICE, NOW)], { invoice_id: "INV2-AAAA", status: "MARKED_AS_PAID" }, NOW);
  assert.equal(next[0].paid, true);
});

test("an event for an unknown invoice adds a row at the top", () => {
  const ev = {
    invoice_id: "INV2-BBBB",
    invoice_number: "CP-2",
    client: "beta@example.com",
    status: "SENT",
    amount: "300.00",
    currency: "USD",
    due_date: "2026-11-01",
  };
  const next = applyEvent([toRow(INVOICE, NOW)], ev, NOW);
  assert.equal(next.length, 2);
  assert.equal(next[0].id, "INV2-BBBB");
  assert.equal(next[0].amount, 300);
});

test("an unpaid row carries its risk bucket and expected pay date", () => {
  // 3 days overdue on 1,200: medium risk, so a week from today.
  const row = toRow(INVOICE, NOW);
  assert.equal(row.risk, "medium");
  assert.equal(row.expected_pay_date, "2026-10-28");
});

test("expected pay date: on the due date when not yet due", () => {
  assert.equal(expectedPayDate({ dueDate: "2026-10-30", paid: false, days: 0, bucket: "low", now: NOW }), "2026-10-30");
});

test("a large invoice that isn't due yet is low risk, expected on its due date", () => {
  const row = toRow({ ...INVOICE, detail: { ...INVOICE.detail, payment_term: { due_date: "2026-11-04" } } }, NOW);
  assert.equal(row.amount, 1200);
  assert.equal(row.risk, "low");
  assert.equal(row.expected_pay_date, "2026-11-04");
});

test("expected pay date: overdue rows land after today, later for higher risk", () => {
  assert.equal(expectedPayDate({ dueDate: "2026-10-18", paid: false, days: 3, bucket: "low", now: NOW }), "2026-10-24");
  assert.equal(expectedPayDate({ dueDate: "2026-10-01", paid: false, days: 20, bucket: "high", now: NOW }), "2026-11-11");
});

test("paid rows have no risk label, no expected date and no cash-panel amounts", () => {
  const row = toRow({ ...INVOICE, status: "PAID" }, NOW);
  assert.equal(row.risk, "");
  assert.equal(row.expected_pay_date, "");
  assert.deepEqual([row.outstanding, row.overdue_amount, row.expected_7d, row.at_risk], [0, 0, 0, 0]);
});

test("cash-panel amounts: outstanding, overdue, expected within 7 days, at risk", () => {
  const soon = toRow({ ...INVOICE, amount: { value: "300.00", currency_code: "USD" } }, NOW); // low, 3d overdue → Oct 24
  assert.deepEqual([soon.outstanding, soon.overdue_amount, soon.expected_7d, soon.at_risk], [300, 300, 300, 0]);
  const late = toRow({ ...INVOICE, detail: { ...INVOICE.detail, payment_term: { due_date: "2026-10-01" } } }, NOW); // 20d → high
  assert.deepEqual([late.outstanding, late.overdue_amount, late.expected_7d, late.at_risk], [1200, 1200, 0, 1200]);
  const notDue = toRow({ ...INVOICE, amount: { value: "300.00", currency_code: "USD" }, detail: { ...INVOICE.detail, payment_term: { due_date: "2026-11-30" } } }, NOW);
  assert.deepEqual([notDue.outstanding, notDue.overdue_amount, notDue.expected_7d, notDue.at_risk], [300, 0, 0, 0]);
});

test("a PAID event clears the row's cash-panel amounts and expected date", () => {
  const next = applyEvent([toRow(INVOICE, NOW)], { invoice_id: "INV2-AAAA", status: "PAID" }, NOW);
  assert.equal(next[0].risk, "");
  assert.equal(next[0].expected_pay_date, "");
  assert.equal(next[0].outstanding, 0);
});

test("drafts and cancelled invoices are not receivables", () => {
  for (const status of ["DRAFT", "CANCELLED", "REFUNDED", "SCHEDULED"]) {
    const row = toRow({ ...INVOICE, status, detail: { ...INVOICE.detail, payment_term: { due_date: "2026-09-01" } } }, NOW);
    assert.deepEqual([row.risk, row.outstanding, row.overdue_amount, row.at_risk, row.expected_pay_date], ["", 0, 0, 0, ""], status);
  }
});

test("a partly paid invoice counts only what is still due", () => {
  const row = toRow({ ...INVOICE, status: "PARTIALLY_PAID", due_amount: { value: "200.00", currency_code: "USD" } }, NOW);
  assert.equal(row.amount, 1200);
  assert.equal(row.outstanding, 200);
  assert.equal(row.overdue_amount, 200);
});

test("a schedule hold event marks the row held and back, without touching its status; unknown rows are ignored", () => {
  const rows = [toRow(INVOICE, NOW)];
  const held = applyEvent(rows, { event_type: "APP.SCHEDULE.UPDATED", invoice_id: "INV2-AAAA", held: true }, NOW);
  assert.equal(held[0].held, true);
  assert.equal(held[0].status, rows[0].status);
  const cleared = applyEvent(held, { event_type: "APP.SCHEDULE.UPDATED", invoice_id: "INV2-AAAA", held: false }, NOW);
  assert.equal(cleared[0].held, false);
  assert.equal(applyEvent(rows, { event_type: "APP.SCHEDULE.UPDATED", invoice_id: "INV2-NEW", held: true }, NOW), rows);
});

test("client column shows a name: PayPal's recipient name, else the business, else the email's local part", () => {
  const withName = { ...INVOICE, primary_recipients: [{ billing_info: { email_address: "j@x.com", name: { given_name: "Jordan", surname: "Lee" } } }] };
  assert.equal(toRow(withName, NOW).client_name, "Jordan Lee");
  const business = { ...INVOICE, primary_recipients: [{ billing_info: { email_address: "ap@acme.com", business_name: "Acme Studio" } }] };
  assert.equal(toRow(business, NOW).client_name, "Acme Studio");
  const bare = { ...INVOICE, primary_recipients: [{ billing_info: { email_address: "billing.team@acme.com" } }] };
  assert.equal(toRow(bare, NOW).client_name, "billing.team");
  assert.equal(toRow(bare, NOW).client, "billing.team@acme.com", "the email stays for the AI and the phone list");
  const sandbox = { ...INVOICE, primary_recipients: [{ billing_info: { email_address: "sb-mon6753195394@personal.example.com" } }] };
  assert.equal(toRow(sandbox, NOW).client_name, "Sandbox buyer");
});

test("attention order: held, then most overdue, then by due date; paid and cancelled last", () => {
  const row = (id, status, due, extra = {}) => toRow({ ...INVOICE, id, status, detail: { ...INVOICE.detail, invoice_number: id, payment_term: { due_date: due } } }, NOW, extra.held ? { held: true, project: "", dueDate: due } : null);
  const rows = [
    row("paid-new", "PAID", "2026-10-20"),
    row("due-later", "SENT", "2026-11-30"),
    row("cancelled", "CANCELLED", "2026-10-01"),
    row("overdue-3", "SENT", "2026-10-18"),
    row("due-soon", "SENT", "2026-10-25"),
    row("overdue-20", "SENT", "2026-10-01"),
    row("held", "SENT", "2026-10-10", { held: true }),
  ];
  assert.deepEqual(byAttention(rows).map((r) => r.id), ["held", "overdue-20", "overdue-3", "due-soon", "due-later", "paid-new", "cancelled"]);
  assert.equal(rows[0].id, "paid-new", "input is not mutated");
});
