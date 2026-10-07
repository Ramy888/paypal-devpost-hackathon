import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findRetainerCandidates,
  validateOffer,
  verifyReturn,
  subscriptionEvent,
  applySubscriptionEvent,
  createOffer,
  startSubscription,
  endRetainer,
} from "../lib/retainers.mjs";

const inv = (id, email, value, status = "PAID", over = {}) => ({
  id,
  status,
  amount: { value: String(value), currency_code: "USD" },
  detail: { invoice_number: id, invoice_date: `2026-09-${String(10 + Number(id.slice(1))).padStart(2, "0")}` },
  primary_recipients: [{ billing_info: { email_address: email, business_name: "Acme" } }],
  ...over,
});

test("a client with two or more paid invoices becomes a candidate at the median amount", () => {
  const out = findRetainerCandidates({
    invoices: [inv("A1", "acme@x.com", 300), inv("A2", "ACME@x.com", 340), inv("A3", "acme@x.com", 900), inv("B1", "solo@x.com", 500)],
  });
  assert.equal(out.length, 1);
  assert.deepEqual(
    { email: out[0].clientEmail, name: out[0].clientName, count: out[0].paidCount, amount: out[0].suggestedAmount },
    { email: "acme@x.com", name: "Acme", count: 3, amount: 340 },
  );
});

test("unpaid invoices don't count, and clients with an open retainer are skipped", () => {
  const invoices = [inv("A1", "acme@x.com", 300), inv("A2", "acme@x.com", 300, "SENT"), inv("C1", "c@x.com", 200), inv("C2", "c@x.com", 200)];
  assert.equal(findRetainerCandidates({ invoices }).length, 1); // only c@x.com
  assert.equal(findRetainerCandidates({ invoices, existing: [{ clientEmail: "C@x.com", status: "active" }] }).length, 0);
  assert.equal(findRetainerCandidates({ invoices, existing: [{ clientEmail: "c@x.com", status: "cancelled" }] }).length, 1);
});

test("offers are validated before reaching PayPal", () => {
  assert.equal(validateOffer({ clientEmail: "a@x.com", amount: 300, currency: "USD", description: "Monthly edits" }).ok, true);
  const bad = validateOffer({ clientEmail: "nope", amount: 0, currency: "usd", description: "" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /client email.*amount.*currency.*covers/);
});

const row = { id: "r1", publicId: "pub", planId: "P-1", subscriptionId: "I-1", status: "pending", paymentsCount: 0, paidTotal: 0, lastSaleId: null };

test("the return page only trusts the subscription we created, on our plan, and running", () => {
  assert.equal(verifyReturn({ retainer: row, subscription: { id: "I-1", plan_id: "P-1", status: "ACTIVE" } }).ok, true);
  assert.equal(verifyReturn({ retainer: row, subscription: { id: "I-2", plan_id: "P-1", status: "ACTIVE" } }).reason, "NOT_THIS_SUBSCRIPTION");
  assert.equal(verifyReturn({ retainer: row, subscription: { id: "I-1", plan_id: "P-9", status: "ACTIVE" } }).reason, "WRONG_PLAN");
  assert.equal(verifyReturn({ retainer: row, subscription: { id: "I-1", plan_id: "P-1", status: "APPROVAL_PENDING" } }).reason, "NOT_ACTIVE");
  assert.equal(verifyReturn({ retainer: { ...row, subscriptionId: null }, subscription: { id: "I-1" } }).ok, false);
});

test("subscription webhooks are recognised; an ordinary invoice sale is ignored", () => {
  assert.deepEqual(subscriptionEvent({ event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: "I-1" } }), { subscriptionId: "I-1", status: "active" });
  assert.deepEqual(subscriptionEvent({ event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "S-1", billing_agreement_id: "I-1", amount: { total: "300.00" } } }), {
    subscriptionId: "I-1",
    saleId: "S-1",
    amount: 300,
  });
  assert.equal(subscriptionEvent({ event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "S-2", amount: { total: "50.00" } } }), null);
  assert.equal(subscriptionEvent({ event_type: "INVOICING.INVOICE.PAID", resource: {} }), null);
});

test("payments are counted once each, and a cancelled retainer is never reopened", () => {
  const now = new Date("2026-10-08T00:00:00Z");
  const paid = applySubscriptionEvent(row, { saleId: "S-1", amount: 300 }, now);
  assert.deepEqual(paid, { paymentsCount: 1, paidTotal: 300, lastPaymentAt: now, lastSaleId: "S-1" });
  assert.equal(applySubscriptionEvent({ ...row, ...paid }, { saleId: "S-1", amount: 300 }, now), null);
  assert.deepEqual(applySubscriptionEvent(row, { status: "active" }, now), { status: "active", activatedAt: now });
  assert.equal(applySubscriptionEvent({ ...row, status: "cancelled" }, { status: "active" }, now), null);
  assert.equal(applySubscriptionEvent({ ...row, status: "offered" }, { status: "active" }, now), null);
});

// Fakes for the PayPal-calling helpers.
function fakePayPal() {
  const calls = [];
  return {
    calls,
    async request(method, path, body, opts) {
      calls.push({ method, path, body, requestId: opts?.headers?.["PayPal-Request-Id"] });
      if (path === "/v1/catalogs/products") return { id: "PROD-1" };
      if (path === "/v1/billing/plans") return { id: "P-1" };
      if (path === "/v1/billing/subscriptions") return { id: "I-1", links: [{ rel: "approve", href: "https://paypal.test/approve" }] };
      return {};
    },
  };
}
function memoryStore() {
  const settings = {};
  const rows = [];
  return {
    rows,
    getSetting: async (k) => settings[k] ?? null,
    setSetting: async (k, v) => void (settings[k] = v),
    insertRetainer: async (r) => (rows.push({ id: `r${rows.length + 1}`, status: "offered", ...r }), rows.at(-1)),
    setRetainerSubscription: async (id, subId) => Object.assign(rows.find((r) => r.id === id), { subscriptionId: subId, status: "pending" }),
    updateRetainer: async (id, patch) => Object.assign(rows.find((r) => r.id === id), patch),
  };
}
const OFFER = { clientEmail: "acme@x.com", clientName: "Acme", amount: 300, currency: "USD", description: "Monthly video edits" };

test("an offer creates the product once and one monthly plan per offer", async () => {
  const paypal = fakePayPal();
  const store = memoryStore();
  await createOffer({ paypal, store, offer: OFFER, freelancerName: "Ramy Video Editing Studio", publicId: "pub1" });
  await createOffer({ paypal, store, offer: OFFER, freelancerName: "Ramy Video Editing Studio", publicId: "pub2" });
  assert.equal(paypal.calls.filter((c) => c.path === "/v1/catalogs/products").length, 1);
  const plan = paypal.calls.find((c) => c.path === "/v1/billing/plans").body;
  assert.equal(plan.billing_cycles[0].pricing_scheme.fixed_price.value, "300.00");
  assert.equal(plan.billing_cycles[0].frequency.interval_unit, "MONTH");
  assert.equal(store.rows[0].planId, "P-1");
});

test("approving starts a subscription for the offer's client, idempotent within ten minutes", async () => {
  const paypal = fakePayPal();
  const store = memoryStore();
  const retainer = await createOffer({ paypal, store, offer: OFFER, freelancerName: "Ramy", publicId: "pub1" });
  const now = new Date("2026-10-08T10:00:00Z");
  const link = await startSubscription({ paypal, store, retainer, appUrl: "https://app.test", freelancerName: "Ramy", now });
  await startSubscription({ paypal, store, retainer, appUrl: "https://app.test", freelancerName: "Ramy", now: new Date(now.getTime() + 60_000) });
  assert.equal(link, "https://paypal.test/approve");
  const subs = paypal.calls.filter((c) => c.path === "/v1/billing/subscriptions");
  assert.equal(subs[0].requestId, subs[1].requestId);
  assert.equal(subs[0].body.subscriber.email_address, "acme@x.com");
  assert.equal(subs[0].body.application_context.return_url, "https://app.test/retainer/return?r=pub1");
  assert.equal(store.rows[0].status, "pending");
  await assert.rejects(startSubscription({ paypal, store, retainer: { ...retainer, status: "cancelled" }, appUrl: "x", freelancerName: "R" }));
});

test("ending a running retainer cancels it at PayPal; withdrawing an offer only deactivates the plan", async () => {
  const paypal = fakePayPal();
  const store = memoryStore();
  const retainer = await createOffer({ paypal, store, offer: OFFER, freelancerName: "Ramy", publicId: "pub1" });
  await endRetainer({ paypal, store, retainer });
  assert.equal(paypal.calls.some((c) => c.path.endsWith("/cancel")), false);
  assert.ok(paypal.calls.some((c) => c.path === "/v1/billing/plans/P-1/deactivate"));

  await endRetainer({ paypal, store, retainer: { ...retainer, status: "active", subscriptionId: "I-1" } });
  assert.ok(paypal.calls.some((c) => c.path === "/v1/billing/subscriptions/I-1/cancel"));
  assert.equal(store.rows[0].status, "cancelled");
});
