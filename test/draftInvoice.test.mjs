import { test } from "node:test";
import assert from "node:assert/strict";
import { draftInvoice, normalizeDraft } from "../lib/draftInvoice.mjs";
import { toPayPalInvoice, invoiceTotal, InvoiceInputError } from "../lib/invoiceSpec.mjs";

// Fake Anthropic client: records the request and returns a canned parsed draft. No API calls.
function fakeAnthropic(parsed, { stop = "end_turn" } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async parse(req) {
        calls.push(req);
        return { stop_reason: stop, parsed_output: parsed };
      },
    },
  };
}

const GOOD = {
  client_name: "Acme Studio",
  client_email: "Billing@Acme.com ",
  currency: "usd",
  items: [{ name: "Promo video edit", quantity: 1, unit_amount: 1200 }],
  due_in_days: 14,
  note: "Thanks for the project!",
  language: "en",
  missing: [],
};

test("drafts with structured output on the default model and normalises the result", async () => {
  const ai = fakeAnthropic(GOOD);
  const d = await draftInvoice({ anthropic: ai, text: "Bill Acme 1200 dollars for the promo edit, due in 14 days" });
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, "claude-opus-5-5");
  assert.ok(ai.calls[0].output_config.format, "uses structured output");
  assert.equal(d.client_email, "billing@acme.com");
  assert.equal(d.currency, "USD");
  assert.deepEqual(d.missing, []);
});

test("rejects empty or very long input without calling the model", async () => {
  const ai = fakeAnthropic(GOOD);
  await assert.rejects(draftInvoice({ anthropic: ai, text: "   " }));
  await assert.rejects(draftInvoice({ anthropic: ai, text: "x".repeat(2001) }));
  assert.equal(ai.calls.length, 0);
});

test("a refusal or unreadable output becomes a clear error", async () => {
  await assert.rejects(draftInvoice({ anthropic: fakeAnthropic(GOOD, { stop: "refusal" }), text: "bill" }), /could not draft/);
  await assert.rejects(draftInvoice({ anthropic: fakeAnthropic(null), text: "bill" }), /unreadable/);
});

test("never keeps an invented or malformed email, and flags what is missing", () => {
  const d = normalizeDraft({ ...GOOD, client_email: "acme at gmail", items: [{ name: "Edit", quantity: 1, unit_amount: 0 }] });
  assert.equal(d.client_email, "");
  assert.ok(d.missing.includes("client_email"));
  assert.ok(d.missing.includes("amount"));
});

test("an Arabic draft keeps its language", () => {
  const d = normalizeDraft({ ...GOOD, language: "ar", items: [{ name: "مونتاج فيديو", quantity: 1, unit_amount: 1200 }] });
  assert.equal(d.language, "ar");
  assert.equal(d.items[0].name, "مونتاج فيديو");
});

test("builds the PayPal invoice with the studio name, due date, and the connect link", () => {
  const d = normalizeDraft(GOOD);
  const inv = toPayPalInvoice(d, {
    freelancerName: "Ramy Video Editing Studio",
    invoiceNumber: "CP-1",
    appUrl: "https://app.test",
    now: new Date("2026-10-06T10:00:00Z"),
  });
  assert.equal(inv.invoicer.business_name, "Ramy Video Editing Studio");
  assert.equal(inv.detail.payment_term.due_date, "2026-10-20");
  assert.match(inv.detail.terms_and_conditions, /https:\/\/app\.test\/connect\?n=CP-1/);
  assert.equal(inv.items[0].unit_amount.value, "1200.00");
  assert.equal(inv.primary_recipients[0].billing_info.business_name, "Acme Studio");
});

test("refuses to build an invoice without a valid email or price", () => {
  const ctx = { freelancerName: "R", invoiceNumber: "CP-1", appUrl: "https://a" };
  assert.throws(() => toPayPalInvoice({ ...normalizeDraft(GOOD), client_email: "" }, ctx), InvoiceInputError);
  assert.throws(
    () => toPayPalInvoice({ ...normalizeDraft(GOOD), items: [{ name: "Edit", quantity: 1, unit_amount: 0 }] }, ctx),
    InvoiceInputError,
  );
});

test("totals multiply quantity by price and round to cents", () => {
  assert.equal(invoiceTotal([{ quantity: 3, unit_amount: 19.99 }, { quantity: 1, unit_amount: 0.03 }]), 60);
});
