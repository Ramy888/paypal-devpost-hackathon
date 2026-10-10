import { test } from "node:test";
import assert from "node:assert/strict";
import { PAYPAL_CURRENCIES, currencyForCountry, countryFromRequest } from "../lib/currency.mjs";
import { validateInvoiceForm, splitEvenly, capPartAmount } from "../lib/invoiceForm.mjs";
import { normalizeDraft } from "../lib/draftInvoice.mjs";

test("currency follows the visitor's country when PayPal can invoice in it, else USD", () => {
  assert.equal(currencyForCountry("GB"), "GBP");
  assert.equal(currencyForCountry("de"), "EUR");
  assert.equal(currencyForCountry("JP"), "JPY");
  assert.equal(currencyForCountry("EG"), "USD", "PayPal can't invoice in EGP");
  assert.equal(currencyForCountry(undefined), "USD");
  assert.ok(PAYPAL_CURRENCIES.every((c) => /^[A-Z]{3}$/.test(c.code) && c.name));
});

test("country comes from the edge's IP-country header, else the browser's language region", () => {
  assert.equal(countryFromRequest(new Headers({ "cf-ipcountry": "GB" })), "GB");
  assert.equal(countryFromRequest(new Headers({ "x-vercel-ip-country": "DE", "accept-language": "en-US" })), "DE");
  assert.equal(countryFromRequest(new Headers({ "cf-ipcountry": "XX", "accept-language": "fr-CA,fr;q=0.9" })), "CA");
  assert.equal(countryFromRequest(new Headers({ "accept-language": "ar-EG" })), "EG");
  assert.equal(countryFromRequest(new Headers({ "accept-language": "en" })), null);
});

test("a draft without a named currency gets the detected default", () => {
  const base = { client_email: "a@b.com", items: [{ name: "x", quantity: 1, unit_amount: 5 }], due_in_days: 14 };
  assert.equal(normalizeDraft({ ...base, currency: "" }, "GBP").currency, "GBP");
  assert.equal(normalizeDraft({ ...base, currency: "eur" }, "GBP").currency, "EUR");
});

const good = { client_name: "", client_email: "c@acme.com", currency: "USD", items: [{ name: "Edit", quantity: 1, unit_amount: 300 }], due_in_days: 14, note: "" };

test("a complete invoice is valid; each missing or wrong field gets its own message", () => {
  assert.deepEqual(validateInvoiceForm({ draft: good, payMode: "full", parts: [], todayIso: "2026-10-10" }), { valid: true, errors: {} });
  const { valid, errors } = validateInvoiceForm({
    draft: { ...good, client_email: "c@acme.com.", currency: "EGP", items: [{ name: "", quantity: 0, unit_amount: 0 }], due_in_days: -1 },
    payMode: "full",
    parts: [],
    todayIso: "2026-10-10",
  });
  assert.equal(valid, false);
  assert.match(errors.client_email, /valid email/);
  assert.match(errors.currency, /PayPal can't invoice in EGP/);
  assert.match(errors["items.0.name"], /name/);
  assert.match(errors["items.0.quantity"], /at least 1/);
  assert.match(errors["items.0.unit_amount"], /more than 0/);
  assert.match(errors.due_in_days, /0 or more/);
  assert.match(validateInvoiceForm({ draft: { ...good, client_email: "" }, payMode: "full", parts: [], todayIso: "2026-10-10" }).errors.client_email, /required/);
});

test("milestones: each needs a name, amount and future date, and together they must match the total", () => {
  const parts = [{ name: "A", amount: 100, due_date: "2026-10-20" }, { name: "", amount: 0, due_date: "2026-10-01" }];
  const { valid, errors } = validateInvoiceForm({ draft: good, payMode: "milestones", parts, todayIso: "2026-10-10" });
  assert.equal(valid, false);
  assert.match(errors["parts.1.name"], /name/);
  assert.match(errors["parts.1.amount"], /more than 0/);
  assert.match(errors["parts.1.due_date"], /past/);
  assert.equal(errors.parts_total, "$200.00 left to assign to milestones.");
  const ok = validateInvoiceForm({ draft: good, payMode: "milestones", parts: [{ name: "A", amount: 100, due_date: "2026-10-20" }, { name: "B", amount: 200, due_date: "2026-11-20" }], todayIso: "2026-10-10" });
  assert.equal(ok.valid, true);
});

test("splitEvenly re-spreads the total over the milestones, keeping their names and dates", () => {
  const parts = [{ name: "Design", amount: 300, due_date: "2026-10-20" }, { name: "Build", amount: 0, due_date: "2026-11-20" }, { name: "Launch", amount: 0, due_date: "2026-12-20" }];
  assert.deepEqual(splitEvenly(parts, 1000).map((p) => [p.name, p.amount, p.due_date]), [["Design", 333.33, "2026-10-20"], ["Build", 333.33, "2026-11-20"], ["Launch", 333.34, "2026-12-20"]]);
});

test("a milestone amount is capped at what the other milestones leave of the total", () => {
  const parts = [{ amount: 5 }, { amount: 3 }, { amount: 5 }];
  assert.equal(capPartAmount(parts, 1, 9, 15), 5, "15 - 5 - 5 leaves 5");
  assert.equal(capPartAmount(parts, 1, 4, 15), 4);
  assert.equal(capPartAmount(parts, 1, -2, 15), 0);
  assert.equal(capPartAmount([{ amount: 0.1 }, { amount: 0.2 }], 1, 0.3, 0.3), 0.2, "no float drift");
});

test("if the item total drops below the milestones, the message says how much they are over", () => {
  const draft = { client_email: "c@acme.com", currency: "USD", items: [{ name: "Edit", quantity: 1, unit_amount: 10 }], due_in_days: 14 };
  const parts = [{ name: "A", amount: 8, due_date: "2026-10-20" }, { name: "B", amount: 7, due_date: "2026-11-20" }];
  assert.equal(validateInvoiceForm({ draft, payMode: "milestones", parts, todayIso: "2026-10-10" }).errors.parts_total, "Milestones are $5.00 over the invoice total.");
});
