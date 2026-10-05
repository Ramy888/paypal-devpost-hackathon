import { test } from "node:test";
import assert from "node:assert/strict";
import { whatDoIOwe, payInvoice } from "../lib/agentPay.mjs";
import { createEventStore } from "../lib/events.mjs";

const PAYER = { email: "buyer@example.com", vaultId: "VAULT-1" };
const NOW = new Date("2026-10-21T12:00:00Z");

const invoice = (over = {}) => ({
  id: "INV2-AAAA",
  status: "SENT",
  amount: { value: "250.00", currency_code: "USD" },
  due_amount: { value: "250.00", currency_code: "USD" },
  detail: { invoice_number: "CP-1", payment_term: { due_date: "2026-10-18" }, note: "Retainer" },
  primary_recipients: [{ billing_info: { email_address: "buyer@example.com" } }],
  invoicer: { business_name: "Acme Studio" },
  ...over,
});

// Fake PayPal client that records every call and answers by path.
function fakePayPal(inv, { orderStatus = "COMPLETED" } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, path, body, opts) {
      calls.push({ method, path, body, opts });
      if (path.startsWith("/v2/invoicing/search-invoices")) return { items: [inv, invoice({ id: "INV2-OTHER", primary_recipients: [{ billing_info: { email_address: "someone@else.com" } }] })] };
      if (path.startsWith("/v2/invoicing/invoices/") && method === "GET") return inv;
      if (path === "/v2/checkout/orders") {
        return { id: "ORDER-1", status: orderStatus, purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: orderStatus }] } }] };
      }
      if (path.endsWith("/payments")) return { payment_id: "EXTR-1" };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}
const orders = (pp) => pp.calls.filter((c) => c.path === "/v2/checkout/orders");
const pay = (pp, over = {}) =>
  payInvoice({ paypal: pp, payer: PAYER, invoiceId: "INV2-AAAA", spendLimit: 1000, now: NOW, ...over });

test("what_do_i_owe lists only the payer's invoices, most overdue first", async () => {
  const pp = fakePayPal(invoice());
  const owed = await whatDoIOwe({ paypal: pp, payerEmail: PAYER.email, now: NOW });
  assert.equal(owed.length, 1);
  assert.equal(owed[0].invoice_id, "INV2-AAAA");
  assert.equal(owed[0].days_overdue, 3);
  assert.equal(owed[0].from, "Acme Studio");
  assert.deepEqual(pp.calls[0].body.status, ["SENT", "UNPAID", "PARTIALLY_PAID"]);
});

test("refuses an invoice addressed to someone else, without creating an order", async () => {
  const pp = fakePayPal(invoice({ primary_recipients: [{ billing_info: { email_address: "x@y.com" } }] }));
  await assert.rejects(pay(pp), { code: "NOT_YOUR_INVOICE" });
  assert.equal(orders(pp).length, 0);
});

test("refuses an invoice that is already paid", async () => {
  for (const status of ["PAID", "MARKED_AS_PAID", "CANCELLED", "DRAFT"]) {
    const pp = fakePayPal(invoice({ status }));
    await assert.rejects(pay(pp), { code: "NOT_PAYABLE" });
    assert.equal(orders(pp).length, 0);
  }
});

test("refuses an amount over the agent's spending limit", async () => {
  const pp = fakePayPal(invoice());
  await assert.rejects(pay(pp, { spendLimit: 100 }), { code: "OVER_LIMIT" });
  assert.equal(orders(pp).length, 0);
});

test("charges the amount due, not the invoice total", async () => {
  const pp = fakePayPal(invoice({ status: "PARTIALLY_PAID", due_amount: { value: "100.00", currency_code: "USD" } }));
  await pay(pp);
  assert.equal(orders(pp)[0].body.purchase_units[0].amount.value, "100.00");
});

test("pays with the vault token, a fixed request id per invoice, then reconciles and updates dashboards", async () => {
  const pp = fakePayPal(invoice());
  const store = createEventStore();
  const result = await pay(pp, { eventStore: store });

  assert.equal(orders(pp).length, 1);
  const order = orders(pp)[0];
  assert.equal(order.body.payment_source.paypal.vault_id, "VAULT-1");
  assert.equal(order.opts.headers["PayPal-Request-Id"], "collectpilot-pay-INV2-AAAA");

  const recorded = pp.calls.find((c) => c.path.endsWith("/payments"));
  assert.match(recorded.body.note, /CAP-1/);
  assert.equal(recorded.body.amount.value, "250.00");

  assert.equal(store.recent()[0].invoice_id, "INV2-AAAA");
  assert.equal(store.recent()[0].status, "MARKED_AS_PAID");
  assert.deepEqual(result, { paid: true, invoice_id: "INV2-AAAA", invoice_number: "CP-1", amount: "250.00", currency: "USD", paypal_capture_id: "CAP-1" });
  assert.ok(!JSON.stringify(result).includes("VAULT-1"), "never returns the vault token");
});

test("does not record a payment when PayPal did not complete the order", async () => {
  const pp = fakePayPal(invoice(), { orderStatus: "PAYER_ACTION_REQUIRED" });
  await assert.rejects(pay(pp), { code: "PAYMENT_NOT_COMPLETED" });
  assert.equal(pp.calls.filter((c) => c.path.endsWith("/payments")).length, 0);
});
