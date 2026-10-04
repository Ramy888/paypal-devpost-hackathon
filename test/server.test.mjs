import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.mjs";

const SIG_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "t-1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-10-04T20:00:00Z",
};
const EVENT = {
  id: "WH-1",
  event_type: "INVOICING.INVOICE.PAID",
  resource: { invoice: { id: "INV2-AAAA", status: "PAID", amount: { value: "1200.00", currency_code: "USD" } } },
};

async function withServer(deps, fn) {
  const server = createApp({ webhookId: "WHID", adminToken: "admin", log: () => {}, ...deps });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(url);
  } finally {
    server.close();
  }
}

const verifier = (result) => ({ verifyWebhookSignature: async () => result });

test("healthz answers ok", async () => {
  await withServer({ paypal: verifier(true) }, async (url) => {
    const res = await fetch(`${url}/healthz`);
    assert.equal(res.status, 200);
  });
});

test("rejects a webhook without PayPal signature headers", async () => {
  await withServer({ paypal: verifier(true) }, async (url) => {
    const res = await fetch(`${url}/webhooks/paypal`, { method: "POST", body: JSON.stringify(EVENT) });
    assert.equal(res.status, 400);
  });
});

test("rejects a webhook whose signature PayPal does not confirm", async () => {
  await withServer({ paypal: verifier(false) }, async (url) => {
    const res = await fetch(`${url}/webhooks/paypal`, {
      method: "POST",
      headers: SIG_HEADERS,
      body: JSON.stringify(EVENT),
    });
    assert.equal(res.status, 401);
    const events = await (await fetch(`${url}/events`, { headers: { Authorization: "Bearer admin" } })).json();
    assert.equal(events.length, 0);
  });
});

test("returns 503 when no webhook id is configured, so PayPal retries later", async () => {
  await withServer({ paypal: verifier(true), webhookId: "" }, async (url) => {
    const res = await fetch(`${url}/webhooks/paypal`, { method: "POST", headers: SIG_HEADERS, body: "{}" });
    assert.equal(res.status, 503);
  });
});

test("accepts a verified event and records it", async () => {
  await withServer({ paypal: verifier(true) }, async (url) => {
    const res = await fetch(`${url}/webhooks/paypal`, {
      method: "POST",
      headers: SIG_HEADERS,
      body: JSON.stringify(EVENT),
    });
    assert.equal(res.status, 200);
    const events = await (await fetch(`${url}/events`, { headers: { Authorization: "Bearer admin" } })).json();
    assert.equal(events[0].event_type, "INVOICING.INVOICE.PAID");
    assert.equal(events[0].invoice_id, "INV2-AAAA");
    assert.equal(events[0].status, "PAID");
  });
});

test("events list requires the admin token", async () => {
  await withServer({ paypal: verifier(true) }, async (url) => {
    assert.equal((await fetch(`${url}/events`)).status, 401);
    assert.equal((await fetch(`${url}/events`, { headers: { Authorization: "Bearer nope" } })).status, 401);
  });
});

test("refuses bodies over 1 MB", async () => {
  await withServer({ paypal: verifier(true) }, async (url) => {
    const res = await fetch(`${url}/webhooks/paypal`, {
      method: "POST",
      headers: SIG_HEADERS,
      body: "x".repeat(1_100_000),
    });
    assert.equal(res.status, 413);
  });
});
