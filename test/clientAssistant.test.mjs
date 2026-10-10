import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantTurn, assistantSystem, ASSISTANT_TOOLS, FALLBACK_BETA } from "../lib/clientAssistant.mjs";

const PAYER = { id: "PAYER-1", email: "buyer@example.com", vaultId: "VAULT-1", spendLimit: 500 };
const NOW = new Date("2026-10-21T12:00:00Z");

const invoice = (over = {}) => ({
  id: "INV-1",
  status: "SENT",
  amount: { value: "300.00", currency_code: "USD" },
  due_amount: { value: "300.00", currency_code: "USD" },
  detail: { invoice_number: "CP-1", payment_term: { due_date: "2026-10-18" } },
  primary_recipients: [{ billing_info: { email_address: "buyer@example.com" } }],
  ...over,
});

// PayPal fake: search returns the invoices; GET returns one; anything that would move money throws.
function fakePayPal(invoices) {
  const calls = [];
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (path.startsWith("/v2/invoicing/search-invoices")) return { items: invoices };
      const m = path.match(/^\/v2\/invoicing\/invoices\/([^/?]+)$/);
      if (method === "GET" && m) return invoices.find((i) => i.id === decodeURIComponent(m[1]));
      throw new Error(`the assistant must not call ${method} ${path}`);
    },
  };
}

function fakeStore() {
  const parts = [{ id: "PART-1", scheduleId: "S1", seq: 1, name: "First cut", amount: 500, dueDate: "2026-11-01", status: "sent", autopay: true }];
  const updates = [];
  const messages = [];
  return {
    updates,
    messages,
    listSchedulesForPayer: async () => [{ id: "S1", title: "Brand film", currency: "USD", autopay: true }],
    listParts: async () => parts,
    findPart: async (id) => parts.find((p) => p.id === id) ?? null,
    updatePart: async (id, patch) => updates.push({ id, ...patch }),
    insertMessage: async (m) => messages.push(m),
  };
}

// Scripted Claude: returns the queued responses in order and records every request.
function fakeClaude(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (req) => {
          requests.push(structuredClone(req));
          return responses.shift();
        },
      },
    },
  };
}
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const reply = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
const uses = (...blocks) => ({ stop_reason: "tool_use", content: blocks });

const ctx = (invoices = [invoice()], store = fakeStore()) => ({ paypal: fakePayPal(invoices), store, payer: PAYER, now: NOW, freelancer: "Ramy Studio" });

test("tools are strict, with the shapes Claude must fill", () => {
  assert.deepEqual(ASSISTANT_TOOLS.map((t) => t.name), ["what_do_i_owe", "propose_payment", "hold_milestone"]);
  for (const t of ASSISTANT_TOOLS) {
    assert.equal(t.strict, true);
    assert.equal(t.input_schema.additionalProperties, false);
  }
});

test("a question is answered after looking up what is owed, with the fallback and low effort set", async () => {
  const claude = fakeClaude([uses(toolUse("t1", "what_do_i_owe", {})), reply("You owe $300.00 on CP-1, 3 days overdue.")]);
  const c = ctx();
  const out = await assistantTurn({ anthropic: claude, model: "claude-opus-5-5", history: [], userText: "What do I owe?", ctx: c });
  assert.equal(out.reply, "You owe $300.00 on CP-1, 3 days overdue.");
  assert.deepEqual(out.proposals, []);
  const result = JSON.parse(out.history[2].content[0].content);
  assert.equal(result.invoices[0].invoice_id, "INV-1");
  assert.equal(result.schedules[0].milestones[0].part_id, "PART-1");
  assert.equal(claude.requests[0].fallbacks, "default");
  assert.deepEqual(claude.requests[0].betas, [FALLBACK_BETA]);
  assert.equal(claude.requests[0].output_config.effort, "low");
  assert.match(claude.requests[0].system, /Ramy Studio/);
});

test("asking to pay produces a proposal to confirm; nothing is charged", async () => {
  const claude = fakeClaude([uses(toolUse("t1", "propose_payment", { invoice_id: "INV-1", amount: null })), reply("Tap Confirm to pay $300.00.")]);
  const c = ctx();
  const out = await assistantTurn({ anthropic: claude, model: "m", history: [], userText: "Pay it", ctx: c });
  assert.deepEqual(out.proposals, [{ invoice_id: "INV-1", invoice_number: "CP-1", amount: "300.00", currency: "USD", full: true }]);
  assert.ok(c.paypal.calls.every((x) => x.method === "GET"), "only reads");
  assert.match(out.history[2].content[0].content, /"paid":false/);
});

test("a payment over the client's limit is refused to Claude as an error, with no proposal", async () => {
  const big = invoice({ amount: { value: "900.00", currency_code: "USD" }, due_amount: { value: "900.00", currency_code: "USD" } });
  const claude = fakeClaude([uses(toolUse("t1", "propose_payment", { invoice_id: "INV-1", amount: null })), reply("That's over your $500 limit.")]);
  const out = await assistantTurn({ anthropic: claude, model: "m", history: [], userText: "Pay it", ctx: ctx([big]) });
  assert.deepEqual(out.proposals, []);
  const result = out.history[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /OVER_LIMIT/);
});

test("an invoice addressed to someone else can't be proposed", async () => {
  const theirs = invoice({ primary_recipients: [{ billing_info: { email_address: "other@x.com" } }] });
  const claude = fakeClaude([uses(toolUse("t1", "propose_payment", { invoice_id: "INV-1", amount: null })), reply("That isn't yours.")]);
  const out = await assistantTurn({ anthropic: claude, model: "m", history: [], userText: "Pay INV-1", ctx: ctx([theirs]) });
  assert.match(out.history[2].content[0].content, /NOT_YOUR_INVOICE/);
  assert.deepEqual(out.proposals, []);
});

test("holding a milestone records it with the client's note; a milestone from elsewhere is refused", async () => {
  const store = fakeStore();
  const claude = fakeClaude([uses(toolUse("t1", "hold_milestone", { part_id: "PART-1", note: "Colours are off" })), reply("Held.")]);
  await assistantTurn({ anthropic: claude, model: "m", history: [], userText: "First cut isn't done", ctx: ctx([invoice()], store) });
  assert.equal(store.updates[0].status, "on_hold");
  assert.equal(store.messages[0].body, "Colours are off");
  const claude2 = fakeClaude([uses(toolUse("t1", "hold_milestone", { part_id: "PART-X", note: "x" })), reply("Can't.")]);
  const out = await assistantTurn({ anthropic: claude2, model: "m", history: [], userText: "hold", ctx: ctx() });
  assert.match(out.history[2].content[0].content, /not in your schedules/);
});

test("history is append-only: each turn keeps earlier messages exactly and adds the new ones", async () => {
  const claude = fakeClaude([reply("Hi."), reply("Again.")]);
  const first = await assistantTurn({ anthropic: claude, model: "m", history: [], userText: "Hello", ctx: ctx() });
  const second = await assistantTurn({ anthropic: claude, model: "m", history: first.history, userText: "Hello again", ctx: ctx() });
  assert.deepEqual(second.history.slice(0, first.history.length), first.history);
  assert.equal(claude.requests[1].messages.length, 3);
});

test("a refusal gets a plain answer; a runaway tool loop stops", async () => {
  const refused = await assistantTurn({ anthropic: fakeClaude([{ stop_reason: "refusal", content: [] }]), model: "m", history: [], userText: "x", ctx: ctx() });
  assert.match(refused.reply, /can't help/);
  const loop = Array.from({ length: 10 }, (_, i) => uses(toolUse(`t${i}`, "what_do_i_owe", {})));
  const out = await assistantTurn({ anthropic: fakeClaude(loop), model: "m", history: [], userText: "x", ctx: ctx() });
  assert.match(out.reply, /too many steps/);
});

test("payments the client confirmed since the last reply are told to Claude with the next message", async () => {
  const claude = fakeClaude([reply("Noted.")]);
  await assistantTurn({
    anthropic: claude, model: "m", history: [], userText: "Anything else?", ctx: ctx(),
    confirmed: [{ invoice_number: "CP-1", amount: "300.00", currency: "USD", capture: "CAP-9" }],
  });
  const content = claude.requests[0].messages[0].content;
  assert.ok(Array.isArray(content));
  assert.match(content[0].text, /confirmed and paid: CP-1 300.00 USD \(PayPal capture CAP-9\)/);
  assert.equal(content[1].text, "Anything else?");
});

test("the assistant is told to write plain text", () => {
  assert.match(assistantSystem({ freelancer: "R" }), /plain text/i);
});
