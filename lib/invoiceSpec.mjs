// Builds the PayPal invoice for a draft the freelancer approved, and validates it first.
import { isEmail } from "./email.mjs";

export class InvoiceInputError extends Error {}

export function validateApproved(d) {
  if (!isEmail(d.client_email ?? "")) throw new InvoiceInputError("Add the client's email address.");
  if (!Array.isArray(d.items) || d.items.length === 0) throw new InvoiceInputError("Add at least one line item.");
  for (const it of d.items) {
    if (!String(it.name ?? "").trim()) throw new InvoiceInputError("Every line item needs a name.");
    if (!(Number(it.quantity) > 0)) throw new InvoiceInputError(`Quantity for "${it.name}" must be above zero.`);
    if (!(Number(it.unit_amount) > 0)) throw new InvoiceInputError(`Price for "${it.name}" must be above zero.`);
  }
  if (!/^[A-Z]{3}$/.test(d.currency ?? "")) throw new InvoiceInputError("Currency must be a 3-letter code such as USD.");
  if (!(Number.isInteger(d.due_in_days) && d.due_in_days >= 0 && d.due_in_days <= 365)) {
    throw new InvoiceInputError("Due date must be between today and a year from now.");
  }
}

export function invoiceTotal(items) {
  return Math.round(items.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unit_amount), 0) * 100) / 100;
}

/**
 * @param {object} d approved draft (see normalizeDraft)
 * @param {{ freelancerName: string, invoiceNumber: string, appUrl: string, now?: Date }} ctx
 */
export function toPayPalInvoice(d, { freelancerName, invoiceNumber, appUrl, now = new Date() }) {
  validateApproved(d);
  const due = new Date(now.getTime() + d.due_in_days * 86_400_000).toISOString().slice(0, 10);
  const connectLink = `${appUrl}/connect?n=${encodeURIComponent(invoiceNumber)}`;
  return {
    detail: {
      invoice_number: invoiceNumber,
      currency_code: d.currency,
      note: d.note || `Thank you for working with ${freelancerName}.`,
      terms_and_conditions: `Want your AI assistant to pay invoices like this automatically? Connect it once: ${connectLink}`,
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: due },
    },
    invoicer: { business_name: freelancerName },
    primary_recipients: [
      { billing_info: { email_address: d.client_email, ...(d.client_name ? { business_name: d.client_name } : {}) } },
    ],
    items: d.items.map((it) => ({
      name: it.name.slice(0, 200),
      quantity: String(it.quantity),
      unit_amount: { currency_code: d.currency, value: Number(it.unit_amount).toFixed(2) },
    })),
  };
}
