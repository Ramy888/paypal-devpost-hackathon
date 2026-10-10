import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmail } from "../lib/email.mjs";
import { validateApproved } from "../lib/invoiceSpec.mjs";
import { validateOffer } from "../lib/retainers.mjs";

test("isEmail accepts real addresses and rejects ones PayPal refuses", () => {
  for (const ok of ["sb-mon6753195394@personal.example.com", "billing@acme.co.uk", "a.b+tag@x-y.io"]) assert.ok(isEmail(ok), ok);
  for (const bad of ["sb-mon@personal.example.com.", "a@b", "a@.com", "a@b..com", "a b@c.com", "", undefined, "a@b.c_m"]) assert.ok(!isEmail(bad), String(bad));
});

test("invoices and retainer offers use the same check (trailing dot rejected)", () => {
  const draft = { client_name: "", client_email: "c@acme.com.", currency: "USD", items: [{ name: "x", quantity: 1, unit_amount: 5 }], due_in_days: 14, note: "", language: "en", missing: [] };
  assert.throws(() => validateApproved(draft));
  const offer = validateOffer({ clientEmail: "c@acme.com.", clientName: "", amount: 100, currency: "USD", description: "Monthly edits" });
  assert.equal(offer.ok, false);
});
