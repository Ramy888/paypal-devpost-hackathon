import { test } from "node:test";
import assert from "node:assert/strict";
import { toRow, applyEvent, daysOverdue } from "../lib/invoices.mjs";

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
