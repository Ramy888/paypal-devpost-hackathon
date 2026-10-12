import { test } from "node:test";
import assert from "node:assert/strict";
import { startConnection, completeConnection, payerForKey, revokeConnection, sha256 } from "../lib/connect.mjs";

const NOW = new Date("2026-10-06T10:00:00Z");

function memoryStore() {
  const pending = [];
  const payers = [];
  return {
    pending,
    payers,
    async insertPending(p) {
      pending.push({ id: `p${pending.length + 1}`, usedAt: null, ...p });
    },
    async findPending(nonceHash) {
      return pending.find((p) => p.nonceHash === nonceHash) ?? null;
    },
    async markPendingUsed(id) {
      pending.find((p) => p.id === id).usedAt = NOW;
    },
    async insertPayer(p) {
      const row = { id: `payer${payers.length + 1}`, status: "active", ...p };
      payers.push(row);
      return row;
    },
    async findActivePayerByKeyHash(hash) {
      return payers.find((p) => p.agentKeyHash === hash && p.status === "active") ?? null;
    },
    async findPayer(id) {
      return payers.find((p) => p.id === id) ?? null;
    },
    async revokePayer(id) {
      payers.find((p) => p.id === id).status = "revoked";
    },
  };
}

function fakePayPal({ setupStatus = "APPROVED" } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/v3/vault/setup-tokens") {
        return { id: "ST-1", links: [{ rel: "approve", href: "https://sandbox.paypal.com/approve?x=ST-1" }] };
      }
      if (method === "GET" && path.startsWith("/v3/vault/setup-tokens/")) return { id: "ST-1", status: setupStatus };
      if (method === "POST" && path === "/v3/vault/payment-tokens") {
        return { id: "VAULT-9", payment_source: { paypal: { email_address: "client@example.com" } } };
      }
      if (method === "DELETE") return {};
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

const start = (pp, store, over = {}) =>
  startConnection({ paypal: pp, store, appUrl: "https://app.test", invoiceId: "INV2-1", spendLimit: 500, now: NOW, ...over });

test("start returns PayPal's approval link and stores only a hash of the browser nonce", async () => {
  const pp = fakePayPal();
  const store = memoryStore();
  const { approveUrl, nonce } = await start(pp, store);
  assert.match(approveUrl, /paypal\.com/);
  assert.equal(store.pending[0].nonceHash, sha256(nonce));
  assert.ok(!JSON.stringify(store.pending).includes(nonce));
  assert.equal(pp.calls[0].body.payment_source.paypal.experience_context.return_url, "https://app.test/connect/return");
});

test("cancelling on PayPal returns to /connect/cancelled, or to the schedule when it is for auto-pay", async () => {
  const pp = fakePayPal();
  await start(pp, memoryStore());
  assert.equal(pp.calls[0].body.payment_source.paypal.experience_context.cancel_url, "https://app.test/connect/cancelled");
  const pp2 = fakePayPal();
  await start(pp2, memoryStore(), { spendLimit: 300, schedule: { id: "S1", title: "Brand film" }, cancelUrl: "https://app.test/pay/abc?problem=cancelled" });
  assert.equal(pp2.calls[0].body.payment_source.paypal.experience_context.cancel_url, "https://app.test/pay/abc?problem=cancelled");
});

test("start rejects a limit that was not offered", async () => {
  await assert.rejects(start(fakePayPal(), memoryStore(), { spendLimit: 99999 }), { code: "BAD_LIMIT" });
});

test("a different browser (wrong nonce) cannot complete the connection, and PayPal is never called", async () => {
  const pp = fakePayPal();
  const store = memoryStore();
  await start(pp, store);
  const before = pp.calls.length;
  await assert.rejects(completeConnection({ paypal: pp, store, nonce: "someone-else", now: NOW }), { code: "NO_PENDING" });
  await assert.rejects(completeConnection({ paypal: pp, store, nonce: "", now: NOW }), { code: "NO_PENDING" });
  assert.equal(pp.calls.length, before);
});

test("no payer is created until PayPal reports the approval", async () => {
  const store = memoryStore();
  const { nonce } = await start(fakePayPal(), store);
  await assert.rejects(completeConnection({ paypal: fakePayPal({ setupStatus: "PAYER_ACTION_REQUIRED" }), store, nonce, now: NOW }), { code: "NOT_APPROVED" });
  assert.equal(store.payers.length, 0);
});

test("an expired approval cannot be completed", async () => {
  const store = memoryStore();
  const { nonce } = await start(fakePayPal(), store);
  const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
  await assert.rejects(completeConnection({ paypal: fakePayPal(), store, nonce, now: later }), { code: "EXPIRED" });
});

test("completing stores the PayPal account and only a hash of the agent key; the key works once issued", async () => {
  const pp = fakePayPal();
  const store = memoryStore();
  const { nonce } = await start(pp, store);
  const { payer, agentKey } = await completeConnection({ paypal: pp, store, nonce, now: NOW });

  assert.match(agentKey, /^cp_agent_/);
  assert.equal(payer.paypalEmail, "client@example.com");
  assert.equal(payer.vaultId, "VAULT-9");
  assert.equal(payer.spendLimit, 500);
  assert.ok(!JSON.stringify(store.payers).includes(agentKey), "the raw key is never stored");
  assert.equal((await payerForKey({ store, agentKey })).id, payer.id);

  await assert.rejects(completeConnection({ paypal: pp, store, nonce, now: NOW }), { code: "ALREADY_USED" });
});

test("revoking deletes the PayPal token and the key stops working", async () => {
  const pp = fakePayPal();
  const store = memoryStore();
  const { nonce } = await start(pp, store);
  const { payer, agentKey } = await completeConnection({ paypal: pp, store, nonce, now: NOW });

  assert.equal(await revokeConnection({ paypal: pp, store, payerId: payer.id }), true);
  assert.ok(pp.calls.some((c) => c.method === "DELETE" && c.path === "/v3/vault/payment-tokens/VAULT-9"));
  assert.equal(await payerForKey({ store, agentKey }), null);
});

test("keys without the agent prefix are rejected before any lookup", async () => {
  const store = memoryStore();
  let looked = false;
  store.findActivePayerByKeyHash = async () => ((looked = true), null);
  assert.equal(await payerForKey({ store, agentKey: "random" }), null);
  assert.equal(looked, false);
});

test("auto-pay for a schedule: consent names the schedule and a per-charge limit, and the result carries the schedule", async () => {
  const pp = fakePayPal();
  const store = memoryStore();
  const { nonce } = await start(pp, store, { invoiceId: "", spendLimit: 1200, schedule: { id: "SCH-1", title: "Acme website" } });
  const description = pp.calls[0].body.payment_source.paypal.description;
  assert.match(description, /Acme website/);
  assert.match(description, /1200 USD per charge/);
  assert.equal(store.pending[0].scheduleId, "SCH-1");
  const { pending } = await completeConnection({ paypal: pp, store, nonce, now: NOW });
  assert.equal(pending.scheduleId, "SCH-1");
});

test("a schedule's limit is its largest part, not one of the agent limits", async () => {
  await assert.rejects(start(fakePayPal(), memoryStore(), { spendLimit: 0, schedule: { id: "S", title: "T" } }), { code: "BAD_LIMIT" });
});

test("an auto-pay approval for a schedule issues no agent key", async () => {
  const pp = fakePayPal();
  const store = memoryStore();
  const { nonce } = await start(pp, store, { invoiceId: "", spendLimit: 5000, schedule: { id: "SCH-1", title: "Big job" } });
  const { agentKey, payer } = await completeConnection({ paypal: pp, store, nonce, now: NOW });
  assert.equal(agentKey, null);
  assert.ok(payer.agentKeyHash, "an unusable hash still fills the column");
});
