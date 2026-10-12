import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSchedule,
  approveSchedule,
  sendDueMilestones,
  chargeDueParts,
  reconcileInvoice,
  holdPartOp,
  proposeDateOp,
  approveDateOp,
  releaseHoldOp,
  scheduleInvoiceBody,
  schedulesOwed,
} from "../lib/scheduleOps.mjs";
import { createOrdersApi } from "../lib/paypalOrders.mjs";
import { createEventStore } from "../lib/events.mjs";
import { AUTOPAY_NOTE_PREFIX } from "../lib/agentPay.mjs";

const NOW = new Date("2026-11-01T09:00:00Z");
const CTX = { freelancerName: "Ramy Studio", appUrl: "https://cp.example" };
const PAYER = { id: "PAYER-1", status: "active", vaultId: "VAULT-1", spendLimit: 1500 };

// In-memory store with the methods the schedule operations use.
function memStore() {
  const s = { schedules: [], parts: [], charges: [], payments: [], messages: [] };
  return {
    s,
    async insertSchedule({ parts, ...row }) {
      const sched = { id: `S${s.schedules.length + 1}`, status: "proposed", autopay: false, payerId: null, invoiceId: null, ...row };
      s.schedules.push(sched);
      parts.forEach((p) => s.parts.push({ id: `${sched.id}-P${p.seq}`, scheduleId: sched.id, status: "scheduled", invoiceId: null, holdNote: "", ...p }));
      return { ...sched };
    },
    async approveSchedule(id, { autopay, payerId, now }) {
      const sched = s.schedules.find((x) => x.id === id && x.status === "proposed");
      if (!sched) return null;
      Object.assign(sched, { status: "approved", autopay, payerId, approvedAt: now });
      return { ...sched };
    },
    async setScheduleInvoice(id, invoiceId) {
      const sched = s.schedules.find((x) => x.id === id);
      sched.invoiceId ??= invoiceId;
    },
    findScheduleByInvoice: async (invoiceId) => s.schedules.find((x) => x.invoiceId === invoiceId) ?? null,
    findSchedule: async (id) => ({ ...s.schedules.find((x) => x.id === id) }),
    listParts: async (scheduleId) => s.parts.filter((p) => p.scheduleId === scheduleId).map((p) => ({ ...p })),
    findPartByInvoice: async (invoiceId) => s.parts.find((p) => p.invoiceId === invoiceId) ?? null,
    async updatePart(id, patch) {
      Object.assign(s.parts.find((p) => p.id === id), patch);
    },
    async insertCharge(row) {
      s.charges.push({ attemptedAt: new Date(), ...row });
    },
    listCharges: async (ids) => s.charges.filter((c) => ids.includes(c.partId)),
    async recordPayment(id, amount) {
      s.payments.push({ id, amount });
    },
    async insertMessage(m) {
      s.messages.push({ id: `M${s.messages.length + 1}`, ...m });
    },
  };
}

// Fake PayPal REST (invoicing): keeps invoices in memory and applies recorded payments.
function fakePayPal() {
  const invoices = new Map();
  const calls = [];
  let n = 0;
  return {
    invoices,
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/v2/invoicing/invoices") {
        const id = `INV-${++n}`;
        const total = body.items.reduce((t, it) => t + Number(it.unit_amount.value) * Number(it.quantity), 0);
        invoices.set(id, { id, status: "DRAFT", ...body, amount: { value: total.toFixed(2), currency_code: "USD" }, due_amount: { value: total.toFixed(2), currency_code: "USD" }, payments: { paid_amount: { value: "0.00" }, transactions: [] } });
        return { id };
      }
      const m = path.match(/^\/v2\/invoicing\/invoices\/([^/?]+)(\/\w+)?/);
      const inv = m && invoices.get(decodeURIComponent(m[1]));
      if (m?.[2] === "/send") return void (inv.status = "SENT");
      if (m?.[2] === "/payments") {
        const paid = Number(inv.payments.paid_amount.value) + Number(body.amount.value);
        const due = Number(inv.amount.value) - paid;
        inv.payments.paid_amount.value = paid.toFixed(2);
        inv.payments.transactions.push(body);
        inv.due_amount.value = due.toFixed(2);
        inv.status = due <= 0 ? "MARKED_AS_PAID" : "PARTIALLY_PAID";
        return {};
      }
      if (method === "GET" && inv) return structuredClone(inv);
      if (method === "PUT" && inv) return void invoices.set(inv.id, { ...inv, ...body });
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

function stubOrders() {
  const requests = [];
  const orders = createOrdersApi({
    apiBase: "https://api-m.sandbox.paypal.com",
    auth: { getToken: async () => "tok", revokeToken: async () => {} },
    adapter: async (config) => {
      requests.push(config);
      const value = JSON.parse(config.data).purchase_units[0].amount.value;
      const body = { id: `ORDER-${requests.length}`, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: `CAP-${requests.length}-${value}`, status: "COMPLETED" }] } }] };
      return { data: JSON.stringify(body), status: 201, statusText: "", headers: { "content-type": "application/json" }, config };
    },
  });
  return { orders, requests };
}

const input = (mode, over = {}) => ({
  mode,
  title: "Acme website",
  clientEmail: "Client@Acme.com",
  clientName: "Acme",
  currency: "USD",
  parts: [
    { name: "Kick-off", amount: 900, dueDate: "2026-11-01" },
    { name: "Design sign-off", amount: 1200, dueDate: "2026-11-10" },
    { name: "Launch", amount: 900, dueDate: "2026-11-20" },
  ],
  ...over,
});

async function setup(mode, { autopay = true } = {}) {
  const store = memStore();
  const paypal = fakePayPal();
  const created = await createSchedule({ store, input: input(mode), publicId: "abcdefgh1234", now: NOW });
  const parts = await store.listParts(created.id);
  const schedule = await approveSchedule({ store, paypal, schedule: created, parts, autopay, payerId: autopay ? PAYER.id : null, ...CTX, now: NOW });
  return { store, paypal, schedule: { ...store.s.schedules[0] }, parts: () => store.listParts(schedule.id) };
}

test("createSchedule totals the parts and stores the client's email in lower case; nothing goes to PayPal", async () => {
  const store = memStore();
  const sched = await createSchedule({ store, input: input("milestones"), publicId: "pub", now: NOW });
  assert.equal(sched.total, 3000);
  assert.equal(sched.clientEmail, "client@acme.com");
  assert.equal(store.s.parts.length, 3);
  await assert.rejects(createSchedule({ store, input: input("milestones", { clientEmail: "nope" }), publicId: "p2", now: NOW }), /client's email/);
});

test("chunks: approval sends one PayPal invoice for the total, allowing part payments down to the smallest part", async () => {
  const { paypal, schedule } = await setup("chunks");
  assert.equal(paypal.invoices.size, 1);
  const inv = paypal.invoices.get(schedule.invoiceId);
  assert.equal(inv.status, "SENT");
  assert.equal(inv.amount.value, "3000.00");
  assert.deepEqual(inv.configuration.partial_payment, { allow_partial_payment: true, minimum_amount_due: { currency_code: "USD", value: "900.00" } });
  assert.equal(inv.detail.payment_term.due_date, "2026-11-20");
  assert.match(inv.detail.terms_and_conditions, /https:\/\/cp.example\/pay\/abcdefgh1234/);
});

test("approval happens once, and auto-pay needs the client's PayPal approval", async () => {
  const store = memStore();
  const created = await createSchedule({ store, input: input("milestones"), publicId: "pub", now: NOW });
  const parts = await store.listParts(created.id);
  await assert.rejects(approveSchedule({ store, paypal: fakePayPal(), schedule: created, parts, autopay: true, ...CTX }), /PayPal approval first/);
  await approveSchedule({ store, paypal: fakePayPal(), schedule: created, parts, ...CTX, now: NOW });
  await assert.rejects(approveSchedule({ store, paypal: fakePayPal(), schedule: created, parts, ...CTX, now: NOW }), /already approved/);
});

test("milestones: each invoice is created and sent 3 days before its due date, once", async () => {
  const { store, paypal, schedule, parts } = await setup("milestones");
  assert.equal(paypal.invoices.size, 0, "nothing sent at approval");
  const sent = await sendDueMilestones({ store, paypal, schedule, parts: await parts(), today: new Date("2026-11-07T09:00:00Z"), ...CTX });
  assert.deepEqual(sent.map((x) => x.partId), ["S1-P1", "S1-P2"]);
  const again = await sendDueMilestones({ store, paypal, schedule, parts: await parts(), today: new Date("2026-11-07T09:00:00Z"), ...CTX });
  assert.deepEqual(again, []);
  const second = paypal.invoices.get(sent[1].invoiceId);
  assert.equal(second.items[0].unit_amount.value, "1200.00");
  assert.equal(second.detail.payment_term.due_date, "2026-11-10");
  assert.match(second.detail.note, /Milestone 2 of 3/);
});

test("auto-pay charges a due milestone with the saved PayPal approval, marks it paid and keeps an audit row", async () => {
  const { store, paypal, schedule, parts } = await setup("milestones");
  await sendDueMilestones({ store, paypal, schedule, parts: await parts(), today: NOW, ...CTX });
  const { orders, requests } = stubOrders();
  const events = createEventStore();
  const results = await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: NOW, eventStore: events });
  assert.deepEqual(results, [{ partId: "S1-P1", outcome: "captured" }]);
  assert.equal(JSON.parse(requests[0].data).payment_source.paypal.vault_id, "VAULT-1");
  const p1 = (await parts())[0];
  assert.equal(p1.status, "paid");
  assert.match(paypal.invoices.get(p1.invoiceId).payments.transactions[0].note, new RegExp(`^${AUTOPAY_NOTE_PREFIX}`));
  assert.deepEqual(store.s.charges.map((c) => c.outcome), ["captured"]);
  assert.deepEqual(store.s.payments, [{ id: "PAYER-1", amount: 900 }]);
  const again = await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: NOW, eventStore: events });
  assert.deepEqual(again, [], "never charged twice");
});

test("chunks: auto-pay charges each part on its date as a part payment of the one invoice", async () => {
  const { store, paypal, schedule, parts } = await setup("chunks");
  const { orders } = stubOrders();
  await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: NOW });
  const inv = paypal.invoices.get(schedule.invoiceId);
  assert.equal(inv.status, "PARTIALLY_PAID");
  assert.equal(inv.payments.paid_amount.value, "900.00");
  await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: new Date("2026-11-10T09:00:00Z") });
  assert.equal(paypal.invoices.get(schedule.invoiceId).payments.paid_amount.value, "2100.00");
  assert.deepEqual((await parts()).map((p) => p.status), ["paid", "paid", "scheduled"]);
});

test("'Not done yet' stops the charge for that part only", async () => {
  const { store, paypal, schedule, parts } = await setup("chunks");
  const [p1] = await parts();
  await holdPartOp({ store, part: p1, note: "Kick-off call not held yet", now: NOW });
  const { orders } = stubOrders();
  const results = await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: new Date("2026-11-10T09:00:00Z") });
  assert.deepEqual(results, [{ partId: "S1-P2", outcome: "captured" }]);
  assert.deepEqual((await parts()).map((p) => p.status), ["on_hold", "paid", "scheduled"]);
});

test("a held part gets a new date only when the client approves it, then auto-pay charges it on that date", async () => {
  const { store, paypal, schedule, parts } = await setup("milestones");
  await sendDueMilestones({ store, paypal, schedule, parts: await parts(), today: NOW, ...CTX });
  let [p1] = await parts();
  p1 = await holdPartOp({ store, part: p1, now: NOW });
  p1 = await proposeDateOp({ store, part: p1, dueDate: "2026-11-05", now: NOW });
  const { orders } = stubOrders();
  assert.deepEqual(await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: new Date("2026-11-05T09:00:00Z") }), [], "still held until approved");
  p1 = await approveDateOp({ store, paypal, part: (await parts())[0] });
  assert.equal(paypal.invoices.get(p1.invoiceId).detail.payment_term.due_date, "2026-11-05", "PayPal invoice moved too");
  assert.deepEqual(await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: new Date("2026-11-04T09:00:00Z") }), []);
  const results = await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: new Date("2026-11-05T09:00:00Z") });
  assert.deepEqual(results.map((r) => r.outcome), ["captured"]);
});

test("releasing a hold puts the part back on its original date", async () => {
  const { store, parts } = await setup("milestones");
  const held = await holdPartOp({ store, part: (await parts())[1], now: NOW });
  await releaseHoldOp({ store, part: held });
  assert.equal((await parts())[1].status, "scheduled");
});

test("a part over the auto-pay limit is not charged; it is recorded once so the freelancer sees it", async () => {
  const { store, paypal, schedule, parts } = await setup("chunks");
  const { orders, requests } = stubOrders();
  const lowLimit = { ...PAYER, spendLimit: 500 };
  const r1 = await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: lowLimit, today: NOW });
  const r2 = await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: lowLimit, today: NOW });
  assert.deepEqual(r1, [{ partId: "S1-P1", outcome: "over_limit" }]);
  assert.deepEqual(r2, []);
  assert.equal(requests.length, 0);
});

test("no auto-pay for a schedule without it, or when the client's PayPal approval was revoked", async () => {
  const off = await setup("chunks", { autopay: false });
  const { orders, requests } = stubOrders();
  assert.deepEqual(await chargeDueParts({ ...off, schedule: off.schedule, parts: await off.parts(), orders, payer: PAYER, today: NOW }), []);
  const on = await setup("chunks");
  assert.deepEqual(await chargeDueParts({ ...on, schedule: on.schedule, parts: await on.parts(), orders, payer: { ...PAYER, status: "revoked" }, today: NOW }), []);
  assert.equal(requests.length, 0);
});

test("a failed charge is recorded and not retried on the same due date", async () => {
  const { store, paypal, schedule, parts } = await setup("chunks");
  const failing = createOrdersApi({
    apiBase: "https://api-m.sandbox.paypal.com",
    auth: { getToken: async () => "tok", revokeToken: async () => {} },
    adapter: async (config) => ({ data: JSON.stringify({ name: "INSTRUMENT_DECLINED" }), status: 422, statusText: "", headers: { "content-type": "application/json" }, config }),
  });
  const r1 = await chargeDueParts({ store, paypal, orders: failing, schedule, parts: await parts(), payer: PAYER, today: NOW });
  const r2 = await chargeDueParts({ store, paypal, orders: failing, schedule, parts: await parts(), payer: PAYER, today: NOW });
  assert.deepEqual(r1, [{ partId: "S1-P1", outcome: "failed" }]);
  assert.deepEqual(r2, []);
  assert.match(store.s.charges[0].detail, /Nothing was charged/);
  assert.equal((await parts())[0].status, "scheduled");
});

test("reconcile: money the client paid on PayPal is spread over chunks in order; a paid milestone invoice marks its part", async () => {
  const chunks = await setup("chunks", { autopay: false });
  await chunks.paypal.request("POST", `/v2/invoicing/invoices/${chunks.schedule.invoiceId}/payments`, { amount: { value: "2100.00" } });
  assert.equal(await reconcileInvoice({ store: chunks.store, paypal: chunks.paypal, invoiceId: chunks.schedule.invoiceId, now: NOW }), true);
  assert.deepEqual((await chunks.parts()).map((p) => p.status), ["paid", "paid", "scheduled"]);

  const ms = await setup("milestones", { autopay: false });
  const [sent] = await sendDueMilestones({ store: ms.store, paypal: ms.paypal, schedule: ms.schedule, parts: await ms.parts(), today: NOW, ...CTX });
  await ms.paypal.request("POST", `/v2/invoicing/invoices/${sent.invoiceId}/payments`, { amount: { value: "900.00" } });
  await reconcileInvoice({ store: ms.store, paypal: ms.paypal, invoiceId: sent.invoiceId, now: NOW });
  assert.equal((await ms.parts())[0].status, "paid");
  assert.equal(await reconcileInvoice({ store: ms.store, paypal: ms.paypal, invoiceId: "INV-UNKNOWN", now: NOW }), false);
});

test("milestone invoice body names the milestone and its place in the schedule", () => {
  const schedule = { publicId: "abcdefgh", title: "Acme website", clientEmail: "c@a.com", clientName: "", currency: "USD", total: 3000 };
  const parts = [{ seq: 1, name: "Kick-off", amount: 900, dueDate: "2026-11-01" }, { seq: 2, name: "Launch", amount: 2100, dueDate: "2026-11-20" }];
  const body = scheduleInvoiceBody({ schedule, parts, part: parts[1], freelancerName: "R", invoiceNumber: "CP-X-M2", appUrl: "https://cp" });
  assert.equal(body.items[0].name, "Acme website: Launch");
  assert.equal(body.configuration, undefined, "a milestone is paid in full");
});

test("a chunked invoice whose send failed is sent on the next pass", async () => {
  const store = memStore();
  const paypal = fakePayPal();
  const created = await createSchedule({ store, input: input("chunks"), publicId: "abcdefgh1234", now: NOW });
  const parts = await store.listParts(created.id);
  const realRequest = paypal.request;
  paypal.request = async (method, path, body) => {
    if (path.endsWith("/send")) throw new Error("PayPal POST send failed: 503");
    return realRequest(method, path, body);
  };
  await approveSchedule({ store, paypal, schedule: created, parts, autopay: true, payerId: PAYER.id, ...CTX, now: NOW });
  const schedule = { ...store.s.schedules[0] };
  assert.equal(schedule.status, "approved", "approval stands even if PayPal's send fails");
  assert.equal(paypal.invoices.get(schedule.invoiceId).status, "DRAFT");
  paypal.request = realRequest;
  const { ensureChunkInvoice } = await import("../lib/scheduleOps.mjs");
  await ensureChunkInvoice({ store, paypal, schedule, parts, ...CTX });
  assert.equal(paypal.invoices.get(schedule.invoiceId).status, "SENT");
  assert.equal(paypal.invoices.size, 1, "no second invoice");
});

test("a milestone the client already paid by hand is marked paid, not charged or failed", async () => {
  const { store, paypal, schedule, parts } = await setup("milestones");
  const [sent] = await sendDueMilestones({ store, paypal, schedule, parts: await parts(), today: NOW, ...CTX });
  await paypal.request("POST", `/v2/invoicing/invoices/${sent.invoiceId}/payments`, { amount: { value: "900.00" }, note: "paid on PayPal" });
  const { orders, requests } = stubOrders();
  const results = await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: NOW });
  assert.deepEqual(results, [{ partId: "S1-P1", outcome: "already_paid" }]);
  assert.equal(requests.length, 0);
  assert.equal((await parts())[0].status, "paid");
  assert.deepEqual(store.s.charges, []);
});

test("a captured chunk that wasn't saved as paid is recognised on the next pass, never charged twice", async () => {
  const { store, paypal, schedule, parts } = await setup("chunks");
  const { orders, requests } = stubOrders();
  const realUpdate = store.updatePart;
  store.updatePart = async () => {
    throw new Error("database unavailable");
  };
  await assert.rejects(chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: NOW }));
  store.updatePart = realUpdate;
  store.s.charges.length = 0; // even with no audit row saved
  const results = await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: NOW });
  assert.deepEqual(results, [{ partId: "S1-P1", outcome: "already_paid" }]);
  assert.equal(requests.length, 1, "one real charge only");
  assert.equal((await parts())[0].status, "paid");
});

test("a capture PayPal reports as pending is 'unconfirmed', not failed", async () => {
  const { store, paypal, schedule, parts } = await setup("chunks");
  const pending = createOrdersApi({
    apiBase: "https://api-m.sandbox.paypal.com",
    auth: { getToken: async () => "tok", revokeToken: async () => {} },
    adapter: async (config) => ({
      data: JSON.stringify({ id: "O", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP-P", status: "PENDING" }] } }] }),
      status: 201, statusText: "", headers: { "content-type": "application/json" }, config,
    }),
  });
  const results = await chargeDueParts({ store, paypal, orders: pending, schedule, parts: await parts(), payer: PAYER, today: NOW });
  assert.deepEqual(results, [{ partId: "S1-P1", outcome: "unconfirmed" }]);
  assert.match(store.s.charges[0].detail, /don't pay it again/i);
});

test("approval and an agent pass running at the same time create one chunk invoice, not two", async () => {
  const { ensureChunkInvoice } = await import("../lib/scheduleOps.mjs");
  const store = memStore();
  const paypal = fakePayPal();
  const slow = paypal.request;
  // Make PayPal slow so both callers are in flight together.
  paypal.request = async (...args) => (await new Promise((r) => setTimeout(r, 5)), slow(...args));
  let queue = Promise.resolve();
  const serialize = (job) => (queue = queue.catch(() => {}).then(job));
  const created = await createSchedule({ store, input: input("chunks"), publicId: "abcdefgh1234", now: NOW });
  const parts = await store.listParts(created.id);
  const approving = approveSchedule({ store, paypal, schedule: created, parts, ...CTX, now: NOW, serialize });
  // The agent pass reads the schedule inside the queue, as runSchedules does.
  const tick = serialize(async () => ensureChunkInvoice({ store, paypal, schedule: await store.findSchedule(created.id), parts, ...CTX }));
  await Promise.all([approving, tick]);
  assert.equal(paypal.invoices.size, 1);
});

test("a schedule refuses a client email PayPal would reject (trailing dot)", async () => {
  await assert.rejects(createSchedule({ store: memStore(), input: input("chunks", { clientEmail: "c@acme.com." }), publicId: "p", now: NOW }), /client's email/);
});

test("the not-done-yet thread: client holds, freelancer marks it fixed, client confirms and the hold lifts", async () => {
  const { holdPartOp, markFixedOp, confirmFixedOp, stillNotDoneOp, replyOp } = await import("../lib/scheduleOps.mjs");
  const { store, parts } = await setup("milestones");
  let p = (await parts())[1];
  p = await holdPartOp({ store, part: p, note: "Logo colours are off", now: NOW });
  p = await replyOp({ store, part: p, author: "freelancer", body: "Fixing them today", now: NOW });
  p = await markFixedOp({ store, part: p, note: "New colours uploaded", now: NOW });
  assert.equal(p.status, "on_hold", "fixed is the freelancer's word; the client confirms");
  assert.ok(p.fixedAt);
  p = await stillNotDoneOp({ store, part: p, note: "Header still blue", now: NOW });
  assert.equal(p.fixedAt, null);
  p = await markFixedOp({ store, part: p, note: "Header fixed", now: NOW });
  p = await confirmFixedOp({ store, part: p, now: NOW });
  assert.equal(p.status, "scheduled");
  assert.deepEqual(store.s.messages.filter((m) => m.partId === p.id).map((m) => [m.author, m.kind]), [
    ["client", "hold"], ["freelancer", "reply"], ["freelancer", "fixed"], ["client", "still_not_done"], ["freelancer", "fixed"], ["client", "confirmed"],
  ]);
  await assert.rejects(markFixedOp({ store, part: p, note: "x", now: NOW }), /not on hold/);
});

test("a client can switch auto-pay off and on for one milestone", async () => {
  const { setPartAutopayOp } = await import("../lib/scheduleOps.mjs");
  const { store, paypal, schedule, parts } = await setup("chunks");
  await setPartAutopayOp({ store, part: (await parts())[0], autopay: false });
  const { orders, requests } = stubOrders();
  assert.deepEqual(await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: NOW }), []);
  assert.equal(requests.length, 0);
  await setPartAutopayOp({ store, part: (await parts())[0], autopay: true });
  assert.deepEqual((await chargeDueParts({ store, paypal, orders, schedule, parts: await parts(), payer: PAYER, today: NOW })).map((r) => r.outcome), ["captured"]);
});

test("schedulesOwed lists the payer's schedules with each milestone's id, date, status and auto-pay", async () => {
  const calls = [];
  const store = {
    async listSchedulesForPayer(q) {
      calls.push(q);
      return [{ id: "S1", title: "Brand film", currency: "USD", autopay: true }];
    },
    async listParts() {
      return [
        { id: "P1", name: "First cut", amount: 500, dueDate: "2026-11-01", status: "on_hold", autopay: true },
        { id: "P2", name: "Final", amount: 700, dueDate: "2026-11-20", status: "scheduled", autopay: false },
      ];
    },
  };
  const out = await schedulesOwed({ store, payer: { id: "PAYER-1", email: "buyer@example.com" } });
  assert.deepEqual(calls, [{ payerId: "PAYER-1", email: "buyer@example.com" }]);
  assert.deepEqual(out, [
    {
      title: "Brand film",
      auto_pay: true,
      milestones: [
        { part_id: "P1", name: "First cut", amount: 500, currency: "USD", due_date: "2026-11-01", status: "not done yet (on hold)", auto_pay: true },
        { part_id: "P2", name: "Final", amount: 700, currency: "USD", due_date: "2026-11-20", status: "scheduled", auto_pay: false },
      ],
    },
  ]);
});

test("hold changes reach live dashboards: the invoice row is marked held, then cleared", async () => {
  const { store, paypal, schedule, parts } = await setup("milestones");
  await sendDueMilestones({ store, paypal, schedule, parts: await parts(), today: NOW, ...CTX });
  const events = createEventStore();
  const seen = [];
  events.subscribe((e) => seen.push(e));
  const [p1] = await parts();
  const held = await holdPartOp({ store, part: p1, note: "Logo colours are off", now: NOW, eventStore: events });
  await releaseHoldOp({ store, part: held, now: NOW, eventStore: events });
  assert.deepEqual(
    seen.map((e) => [e.event_type, e.invoice_id, e.held, e.change]),
    [
      ["APP.SCHEDULE.UPDATED", p1.invoiceId, true, "hold"],
      ["APP.SCHEDULE.UPDATED", p1.invoiceId, false, "released"],
    ],
  );
  assert.match(seen[0].project, /1\/\d/);
});

test("a hold on a milestone not invoiced yet changes nothing on the dashboard, and never fails the hold", async () => {
  const { store, parts } = await setup("milestones");
  const events = createEventStore();
  const seen = [];
  events.subscribe((e) => seen.push(e));
  const held = await holdPartOp({ store, part: (await parts())[1], now: NOW, eventStore: events });
  assert.equal(held.status, "on_hold");
  assert.deepEqual(seen, []);
  const broken = { ...store, findSchedule: async () => { throw new Error("db down"); } };
  const again = await holdPartOp({ store: broken, part: (await parts())[0], now: NOW, eventStore: events });
  assert.equal(again.status, "on_hold");
});
