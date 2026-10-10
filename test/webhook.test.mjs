import { test } from "node:test";
import assert from "node:assert/strict";
import { handleWebhook } from "../lib/webhook.mjs";
import { createEventStore } from "../lib/events.mjs";

const SIG_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "t-1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-10-05T10:00:00Z",
};
const EVENT = {
  id: "WH-1",
  event_type: "INVOICING.INVOICE.PAID",
  resource: {
    invoice: {
      id: "INV2-AAAA",
      status: "PAID",
      amount: { value: "1200.00", currency_code: "USD" },
      detail: { invoice_number: "CP-1", payment_term: { due_date: "2026-10-18" } },
      primary_recipients: [{ billing_info: { email_address: "acme@example.com" } }],
    },
  },
};
const paypal = (verified) => ({ verifyWebhookSignature: async () => verified });
const call = (over = {}) =>
  handleWebhook({ headers: SIG_HEADERS, rawBody: JSON.stringify(EVENT), webhookId: "WHID", paypal: paypal(true), ...over });

test("503 when no webhook id is configured, so PayPal retries later", async () => {
  assert.equal((await call({ webhookId: "" })).status, 503);
});

test("400 without PayPal signature headers", async () => {
  assert.equal((await call({ headers: {} })).status, 400);
});

test("413 for bodies over 1 MB", async () => {
  assert.equal((await call({ rawBody: "x".repeat(1_100_000) })).status, 413);
});

test("401 when PayPal does not confirm the signature", async () => {
  const r = await call({ paypal: paypal(false) });
  assert.equal(r.status, 401);
  assert.equal(r.summary, undefined);
});

test("200 with a summary for a verified event", async () => {
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.summary.invoice_id, "INV2-AAAA");
  assert.equal(r.summary.status, "PAID");
  assert.equal(r.summary.client, "acme@example.com");
  assert.equal(r.summary.due_date, "2026-10-18");
});

test("event store ignores a retried delivery of the same event", () => {
  const store = createEventStore();
  const seen = [];
  store.subscribe((e) => seen.push(e.id));
  assert.equal(store.add({ id: "WH-1" }), true);
  assert.equal(store.add({ id: "WH-1" }), false);
  assert.deepEqual(seen, ["WH-1"]);
  assert.equal(store.recent().length, 1);
});

test("unsubscribed listeners stop receiving events", () => {
  const store = createEventStore();
  const seen = [];
  const off = store.subscribe((e) => seen.push(e.id));
  off();
  store.add({ id: "WH-2" });
  assert.deepEqual(seen, []);
});

test("a retainer change reaches live pages as a non-invoice event, so dashboards ignore it", async () => {
  const { createEventStore, notifyRetainerChange } = await import("../lib/events.mjs");
  const { applyEvent } = await import("../lib/invoices.mjs");
  const store = createEventStore();
  const seen = [];
  store.subscribe((e) => seen.push(e));
  notifyRetainerChange(store);
  notifyRetainerChange(store);
  assert.equal(seen.length, 2, "each change is its own event");
  assert.equal(seen[0].event_type, "APP.RETAINER.UPDATED");
  assert.equal(seen[0].invoice_id, null);
  const rows = [{ id: "INV-1", status: "SENT" }];
  assert.equal(applyEvent(rows, seen[0]), rows);
});
