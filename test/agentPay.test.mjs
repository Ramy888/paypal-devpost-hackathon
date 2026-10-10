import { test } from "node:test";
import assert from "node:assert/strict";
import { whatDoIOwe, payInvoice } from "../lib/agentPay.mjs";
import { createEventStore } from "../lib/events.mjs";
import { createOrdersApi, environmentFor } from "../lib/paypalOrders.mjs";

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

// Fake PayPal REST client (invoicing) that records every call and answers by path.
function fakePayPal(inv) {
  const calls = [];
  return {
    calls,
    async request(method, path, body, opts) {
      calls.push({ method, path, body, opts });
      if (path.startsWith("/v2/invoicing/search-invoices")) return { items: [inv, invoice({ id: "INV2-OTHER", primary_recipients: [{ billing_info: { email_address: "someone@else.com" } }] })] };
      if (path.startsWith("/v2/invoicing/invoices/") && method === "GET") return inv;
      if (path.endsWith("/payments")) return { payment_id: "EXTR-1" };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

// The real PayPal Server SDK OrdersController over a stubbed transport (the SDK's axios-adapter
// seam). It borrows a fake REST token, like production. `responses` answers each order request
// in turn; like PayPal, the full body (with captures) comes back only for Prefer: return=representation.
function stubOrders({ orderStatus = "COMPLETED", responses } = {}) {
  const requests = [];
  const auth = { tokens: ["tok-1", "tok-2"], revoked: 0 };
  auth.getToken = async () => auth.tokens[auth.revoked];
  auth.revokeToken = async () => void auth.revoked++;
  const full = { id: "ORDER-1", status: orderStatus, purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: orderStatus }] } }] };
  const queue = [...(responses ?? [])];
  const orders = createOrdersApi({
    apiBase: "https://api-m.sandbox.paypal.com",
    auth,
    adapter: async (config) => {
      requests.push(config);
      const next = queue.shift() ?? { status: 201 };
      if (next.throw) throw next.throw;
      const prefer = config.headers.Prefer ?? config.headers.prefer;
      const body = next.body ?? (prefer === "return=representation" ? full : { id: "ORDER-1", status: orderStatus });
      return { data: JSON.stringify(body), status: next.status, statusText: "", headers: { "content-type": "application/json" }, config };
    },
  });
  return { orders, requests, auth };
}
const orderRequests = (o) => o.requests.filter((r) => r.url.endsWith("/v2/checkout/orders"));
const pay = (pp, over = {}) =>
  payInvoice({ paypal: pp, orders: (over.stub ?? stubOrders()).orders, payer: PAYER, invoiceId: "INV2-AAAA", spendLimit: 1000, now: NOW, ...over });

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
  const stub = stubOrders();
  await assert.rejects(pay(pp, { stub }), { code: "NOT_YOUR_INVOICE" });
  assert.equal(orderRequests(stub).length, 0);
});

test("refuses an invoice that is already paid", async () => {
  for (const status of ["PAID", "MARKED_AS_PAID", "CANCELLED", "DRAFT"]) {
    const pp = fakePayPal(invoice({ status }));
    const stub = stubOrders();
    await assert.rejects(pay(pp, { stub }), { code: "NOT_PAYABLE" });
    assert.equal(orderRequests(stub).length, 0);
  }
});

test("refuses an amount over the agent's spending limit", async () => {
  const pp = fakePayPal(invoice());
  const stub = stubOrders();
  await assert.rejects(pay(pp, { stub, spendLimit: 100 }), { code: "OVER_LIMIT" });
  assert.equal(orderRequests(stub).length, 0);
});

test("charges the amount due, not the invoice total", async () => {
  const pp = fakePayPal(invoice({ status: "PARTIALLY_PAID", due_amount: { value: "100.00", currency_code: "USD" } }));
  const stub = stubOrders();
  await pay(pp, { stub });
  assert.equal(JSON.parse(orderRequests(stub)[0].data).purchase_units[0].amount.value, "100.00");
});

test("pays with the vault token, a fixed request id per invoice, then reconciles and updates dashboards", async () => {
  const pp = fakePayPal(invoice());
  const store = createEventStore();
  const stub = stubOrders();
  const result = await pay(pp, { stub, eventStore: store });

  assert.equal(orderRequests(stub).length, 1);
  const order = orderRequests(stub)[0];
  assert.equal(order.method.toUpperCase(), "POST");
  const wire = JSON.parse(order.data);
  assert.equal(wire.intent, "CAPTURE");
  assert.equal(wire.payment_source.paypal.vault_id, "VAULT-1");
  assert.equal(wire.purchase_units[0].reference_id, "INV2-AAAA");
  assert.equal(wire.purchase_units[0].invoice_id, "CP-1");
  assert.equal(order.headers["PayPal-Request-Id"] ?? order.headers["paypal-request-id"], "collectpilot-pay-INV2-AAAA-0-250.00");
  assert.match(order.headers.Authorization ?? order.headers.authorization, /Bearer tok-1/);

  const recorded = pp.calls.find((c) => c.path.endsWith("/payments"));
  assert.match(recorded.body.note, /CAP-1/);
  assert.equal(recorded.body.amount.value, "250.00");

  assert.equal(store.recent()[0].invoice_id, "INV2-AAAA");
  assert.equal(store.recent()[0].status, "MARKED_AS_PAID");
  assert.deepEqual(result, { paid: true, invoice_id: "INV2-AAAA", invoice_number: "CP-1", amount: "250.00", currency: "USD", paypal_capture_id: "CAP-1" });
  assert.ok(!JSON.stringify(result).includes("VAULT-1"), "never returns the vault token");
});

test("does not record a payment when PayPal did not complete the order", async () => {
  const pp = fakePayPal(invoice());
  await assert.rejects(pay(pp, { stub: stubOrders({ orderStatus: "PAYER_ACTION_REQUIRED" }) }), { code: "PAYMENT_NOT_COMPLETED" });
  assert.equal(pp.calls.filter((c) => c.path.endsWith("/payments")).length, 0);
});

test("a PayPal error on the order becomes a readable refusal, and nothing is recorded", async () => {
  const pp = fakePayPal(invoice());
  const declined = { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed." } };
  await assert.rejects(pay(pp, { stub: stubOrders({ responses: [declined] }) }), { code: "PAYMENT_FAILED", message: /422.*Nothing was charged/ });
  assert.equal(pp.calls.filter((c) => c.path.endsWith("/payments")).length, 0);
});

test("never says nothing was charged when the capture may have happened", async () => {
  const cases = [
    { status: 503, body: { name: "SERVICE_UNAVAILABLE" } },
    { status: 422, body: { name: "PREVIOUS_REQUEST_IN_PROGRESS" } },
    { throw: Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" }) },
  ];
  for (const c of cases) {
    const pp = fakePayPal(invoice());
    const err = await pay(pp, { stub: stubOrders({ responses: [c] }) }).catch((e) => e);
    assert.equal(err.code, "PAYMENT_UNCONFIRMED", JSON.stringify(c));
    assert.match(err.message, /may have gone through.*safe/);
    assert.doesNotMatch(err.message, /Nothing was charged/);
  }
});

test("asks PayPal for the full order, so a completed capture is never misread as incomplete", async () => {
  const stub = stubOrders();
  await pay(fakePayPal(invoice()), { stub });
  assert.equal(orderRequests(stub)[0].headers.Prefer, "return=representation");
});

test("on 403 NOT_AUTHORIZED (token issued before a scope was enabled) revokes the token and retries once", async () => {
  const stub = stubOrders({ responses: [{ status: 403, body: { name: "NOT_AUTHORIZED", message: "Authorization failed" } }] });
  const result = await pay(fakePayPal(invoice()), { stub });
  assert.equal(result.paid, true);
  assert.equal(stub.auth.revoked, 1);
  const [first, second] = orderRequests(stub);
  assert.match(first.headers.Authorization ?? first.headers.authorization, /tok-1/);
  assert.match(second.headers.Authorization ?? second.headers.authorization, /tok-2/);
  assert.equal(second.headers["PayPal-Request-Id"], first.headers["PayPal-Request-Id"]);
});

test("a later partial payment on the same invoice gets its own request id", async () => {
  const stub = stubOrders();
  const partly = invoice({ status: "PARTIALLY_PAID", due_amount: { value: "100.00", currency_code: "USD" }, payments: { transactions: [{ payment_id: "EXTR-0" }] } });
  await pay(fakePayPal(partly), { stub });
  assert.equal(orderRequests(stub)[0].headers["PayPal-Request-Id"], "collectpilot-pay-INV2-AAAA-1-100.00");
});

test("the SDK only runs against PayPal's own sandbox or live host", () => {
  assert.equal(environmentFor("https://api-m.sandbox.paypal.com/"), "Sandbox");
  assert.equal(environmentFor("https://api-m.paypal.com"), "Production");
  for (const bad of [undefined, "", "http://localhost:4010", "https://api.sandbox.paypal.com"]) assert.throws(() => environmentFor(bad), /PAYPAL_API_BASE/);
});

const partialInvoice = (over = {}) =>
  invoice({
    amount: { value: "3000.00", currency_code: "USD" },
    due_amount: { value: "3000.00", currency_code: "USD" },
    configuration: { partial_payment: { allow_partial_payment: true, minimum_amount_due: { value: "900.00", currency_code: "USD" } } },
    ...over,
  });

test("pays one part of an invoice that allows part payments, and the row shows partly paid", async () => {
  const pp = fakePayPal(partialInvoice());
  const store = createEventStore();
  const stub = stubOrders();
  const result = await pay(pp, { stub, amount: 900, spendLimit: 1000, eventStore: store });
  assert.equal(result.amount, "900.00");
  assert.equal(JSON.parse(orderRequests(stub)[0].data).purchase_units[0].amount.value, "900.00");
  assert.equal(pp.calls.find((c) => c.path.endsWith("/payments")).body.amount.value, "900.00");
  assert.equal(store.recent()[0].status, "PARTIALLY_PAID");
});

test("refuses part payments the invoice doesn't allow, below its minimum, or above what is due", async () => {
  await assert.rejects(pay(fakePayPal(invoice()), { amount: 100 }), { code: "PARTIAL_NOT_ALLOWED" });
  await assert.rejects(pay(fakePayPal(partialInvoice()), { amount: 500 }), { code: "BAD_AMOUNT", message: /smallest part payment.*900/ });
  await assert.rejects(pay(fakePayPal(partialInvoice()), { amount: 3500, spendLimit: 5000 }), { code: "BAD_AMOUNT", message: /Only 3000.00/ });
  await assert.rejects(pay(fakePayPal(partialInvoice()), { amount: 0 }), { code: "BAD_AMOUNT" });
});

test("the spending limit applies to the part being paid, not the whole invoice", async () => {
  const result = await pay(fakePayPal(partialInvoice()), { amount: 900, spendLimit: 1000 });
  assert.equal(result.paid, true);
  await assert.rejects(pay(fakePayPal(partialInvoice()), { spendLimit: 1000 }), { code: "OVER_LIMIT" });
});

test("each payment on the same invoice sends PayPal a unique invoice id (PayPal rejects duplicates)", async () => {
  const stub = stubOrders();
  await pay(fakePayPal(partialInvoice()), { stub, amount: 900, spendLimit: 1000 });
  const later = partialInvoice({ status: "PARTIALLY_PAID", due_amount: { value: "2100.00", currency_code: "USD" }, payments: { transactions: [{ payment_id: "EXTR-1" }] } });
  await pay(fakePayPal(later), { stub, amount: 900, spendLimit: 1000 });
  const [first, second] = orderRequests(stub).map((r) => JSON.parse(r.data).purchase_units[0].invoice_id);
  assert.equal(first, "CP-1");
  assert.equal(second, "CP-1-2");
});

test("a refusal names PayPal's specific reason", async () => {
  const dup = { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "DUPLICATE_INVOICE_ID" }] } };
  await assert.rejects(pay(fakePayPal(invoice()), { stub: stubOrders({ responses: [dup] }) }), { code: "PAYMENT_FAILED", message: /DUPLICATE_INVOICE_ID/ });
});

test("the agent's limit covers everything it pays on one invoice, so part payments can't add up past it", async () => {
  const { AGENT_NOTE_PREFIX } = await import("../lib/agentPay.mjs");
  const paidBefore = partialInvoice({
    status: "PARTIALLY_PAID",
    due_amount: { value: "2100.00", currency_code: "USD" },
    payments: { transactions: [{ note: `${AGENT_NOTE_PREFIX} PayPal capture C0 (order O0)`, amount: { value: "900.00", currency_code: "USD" } }] },
  });
  await assert.rejects(pay(fakePayPal(paidBefore), { amount: 900, spendLimit: 1000 }), { code: "OVER_LIMIT", message: /already paid 900.00/ });
  const result = await pay(fakePayPal(paidBefore), { amount: 900, spendLimit: 2000 });
  assert.equal(result.paid, true);
});
