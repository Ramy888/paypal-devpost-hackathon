import { test } from "node:test";
import assert from "node:assert/strict";
import { createPayPalClient } from "../lib/paypal.mjs";

// A fake fetch that records calls and answers from a list of handlers.
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    const { status = 200, json = {} } = await handler(call, calls);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

const base = "https://api-m.sandbox.paypal.com";
const opts = (fetch) => ({ apiBase: base, clientId: "id", clientSecret: "secret", fetch });

test("reuses a token until it nears expiry", async () => {
  let n = 0;
  const fetch = fakeFetch((c) =>
    c.url.endsWith("/v1/oauth2/token")
      ? { json: { access_token: `tok${++n}`, expires_in: 32400 } }
      : { json: { ok: true } },
  );
  const pp = createPayPalClient(opts(fetch));
  await pp.request("GET", "/v2/invoicing/invoices");
  await pp.request("GET", "/v2/invoicing/invoices");
  assert.equal(fetch.calls.filter((c) => c.url.endsWith("/oauth2/token")).length, 1);
});

test("on 403 NOT_AUTHORIZED, revokes the cached token and retries once with a fresh one", async () => {
  let n = 0;
  const fetch = fakeFetch((c) => {
    if (c.url.endsWith("/v1/oauth2/token")) return { json: { access_token: `tok${++n}`, expires_in: 32400 } };
    if (c.url.endsWith("/v1/oauth2/token/terminate")) return { json: {} };
    // Old token lacks the scope; the fresh token has it.
    return c.headers.Authorization === "Bearer tok1"
      ? { status: 403, json: { name: "NOT_AUTHORIZED" } }
      : { json: { items: [] } };
  });
  const pp = createPayPalClient(opts(fetch));
  const res = await pp.request("GET", "/v2/invoicing/invoices");
  assert.deepEqual(res, { items: [] });
  const terminate = fetch.calls.find((c) => c.url.endsWith("/terminate"));
  assert.ok(terminate, "terminate endpoint was called");
  assert.match(terminate.body, /token=tok1/);
});

test("gives up after one retry and throws with the PayPal error name", async () => {
  let n = 0;
  const fetch = fakeFetch((c) => {
    if (c.url.endsWith("/v1/oauth2/token")) return { json: { access_token: `tok${++n}`, expires_in: 32400 } };
    if (c.url.endsWith("/terminate")) return { json: {} };
    return { status: 403, json: { name: "NOT_AUTHORIZED" } };
  });
  const pp = createPayPalClient(opts(fetch));
  await assert.rejects(pp.request("GET", "/v2/invoicing/invoices"), /403 NOT_AUTHORIZED/);
  assert.equal(fetch.calls.filter((c) => c.url.endsWith("/v2/invoicing/invoices")).length, 2);
});

test("verifyWebhookSignature embeds the raw event body byte-for-byte", async () => {
  const fetch = fakeFetch((c) =>
    c.url.endsWith("/v1/oauth2/token")
      ? { json: { access_token: "tok", expires_in: 32400 } }
      : { json: { verification_status: "SUCCESS" } },
  );
  const pp = createPayPalClient(opts(fetch));
  // Spacing and key order that JSON.stringify would not reproduce.
  const raw = '{"id":"WH-1",  "event_type":"INVOICING.INVOICE.PAID","amount":1.10}';
  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
    "paypal-transmission-id": "t-1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-10-04T20:00:00Z",
  };
  const ok = await pp.verifyWebhookSignature({ headers, rawBody: raw, webhookId: "WHID" });
  assert.equal(ok, true);
  const call = fetch.calls.find((c) => c.url.endsWith("/v1/notifications/verify-webhook-signature"));
  assert.ok(call.body.includes(`"webhook_event":${raw}`));
  assert.equal(JSON.parse(call.body).webhook_id, "WHID");
});

test("verifyWebhookSignature returns false on FAILURE", async () => {
  const fetch = fakeFetch((c) =>
    c.url.endsWith("/v1/oauth2/token")
      ? { json: { access_token: "tok", expires_in: 32400 } }
      : { json: { verification_status: "FAILURE" } },
  );
  const pp = createPayPalClient(opts(fetch));
  const ok = await pp.verifyWebhookSignature({ headers: {}, rawBody: "{}", webhookId: "WHID" });
  assert.equal(ok, false);
});
