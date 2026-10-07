import { test } from "node:test";
import assert from "node:assert/strict";
import { proState, isPro, startPro, confirmPro, applyProEvent, cancelPro } from "../lib/proPlan.mjs";

function memoryStore() {
  const settings = {};
  return { settings, getSetting: async (k) => settings[k] ?? null, setSetting: async (k, v) => void (settings[k] = String(v)) };
}
function fakePayPal(subStatus = "ACTIVE") {
  const calls = [];
  return {
    calls,
    async request(method, path, body, opts) {
      calls.push({ method, path, body, requestId: opts?.headers?.["PayPal-Request-Id"] });
      if (path === "/v1/catalogs/products") return { id: "PROD-PRO" };
      if (path === "/v1/billing/plans") return { id: "P-PRO" };
      if (path === "/v1/billing/subscriptions") return { id: "I-PRO", links: [{ rel: "approve", href: "https://paypal.test/approve" }] };
      if (method === "GET" && path.startsWith("/v1/billing/subscriptions/")) return { id: "I-PRO", plan_id: "P-PRO", status: subStatus };
      return {};
    },
  };
}

test("everyone starts on Free", async () => {
  const s = await proState(memoryStore());
  assert.equal(s.status, "free");
  assert.equal(isPro(s), false);
});

test("upgrading creates the $12 plan once and a pending subscription", async () => {
  const paypal = fakePayPal();
  const store = memoryStore();
  const link = await startPro({ paypal, store, appUrl: "https://app.test" });
  await startPro({ paypal, store, appUrl: "https://app.test" });
  assert.equal(link, "https://paypal.test/approve");
  assert.equal(paypal.calls.filter((c) => c.path === "/v1/billing/plans").length, 1);
  const plan = paypal.calls.find((c) => c.path === "/v1/billing/plans").body;
  assert.equal(plan.billing_cycles[0].pricing_scheme.fixed_price.value, "12.00");
  assert.equal((await proState(store)).status, "pending");
});

test("the return only activates Pro for our subscription when PayPal says ACTIVE", async () => {
  const store = memoryStore();
  await startPro({ paypal: fakePayPal(), store, appUrl: "x" });
  assert.equal((await confirmPro({ paypal: fakePayPal(), store, returnedId: "I-OTHER" })).ok, false);
  assert.equal((await confirmPro({ paypal: fakePayPal("APPROVAL_PENDING"), store, returnedId: "I-PRO" })).ok, false);
  assert.equal((await proState(store)).status, "pending");
  assert.equal((await confirmPro({ paypal: fakePayPal(), store, returnedId: "I-PRO" })).ok, true);
  assert.equal(isPro(await proState(store)), true);
  await assert.rejects(startPro({ paypal: fakePayPal(), store, appUrl: "x" }), /already on Pro/);
});

test("webhooks: other subscriptions are ignored, sales counted once, a cancelled plan stays cancelled", async () => {
  const store = memoryStore();
  await startPro({ paypal: fakePayPal(), store, appUrl: "x" });
  assert.equal(await applyProEvent({ store, ev: { subscriptionId: "I-RETAINER", status: "active" } }), false);
  await applyProEvent({ store, ev: { subscriptionId: "I-PRO", status: "active" } });
  await applyProEvent({ store, ev: { subscriptionId: "I-PRO", saleId: "S-1", amount: 12 } });
  await applyProEvent({ store, ev: { subscriptionId: "I-PRO", saleId: "S-1", amount: 12 } });
  assert.equal((await proState(store)).paymentsCount, 1);

  const paypal = fakePayPal();
  await cancelPro({ paypal, store });
  assert.ok(paypal.calls.some((c) => c.path === "/v1/billing/subscriptions/I-PRO/cancel"));
  await applyProEvent({ store, ev: { subscriptionId: "I-PRO", status: "active" } });
  assert.equal((await proState(store)).status, "cancelled");
});
