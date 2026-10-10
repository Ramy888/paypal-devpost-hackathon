// Checks for the invoice composer: one message per field, so each shows under its own input.
import { isEmail } from "./email.mjs";
import { isPayPalCurrency } from "./currency.mjs";

const cents = (n) => Math.round(Number(n || 0) * 100);
const money = (n, c) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
  } catch {
    return `${Number(n).toFixed(2)} ${c}`;
  }
};

export const formTotal = (items) => items.reduce((t, it) => t + Number(it.quantity || 0) * Number(it.unit_amount || 0), 0);

/** @returns {{ valid: boolean, errors: Record<string, string> }} */
export function validateInvoiceForm({ draft, payMode, parts, todayIso }) {
  const errors = {};
  const email = String(draft.client_email ?? "").trim();
  if (!email) errors.client_email = "Client email is required.";
  else if (!isEmail(email)) errors.client_email = "Enter a valid email, like name@company.com.";
  if (!isPayPalCurrency(draft.currency)) errors.currency = `PayPal can't invoice in ${draft.currency || "that currency"}. Pick one from the list.`;
  if (!draft.items.length) errors.items = "Add at least one line item.";
  draft.items.forEach((it, i) => {
    if (!String(it.name ?? "").trim()) errors[`items.${i}.name`] = "Give this line a name.";
    if (!(Number(it.quantity) >= 1)) errors[`items.${i}.quantity`] = "Quantity must be at least 1.";
    if (!(Number(it.unit_amount) > 0)) errors[`items.${i}.unit_amount`] = "Price must be more than 0.";
  });
  if (payMode === "full") {
    if (!(Number.isInteger(draft.due_in_days) && draft.due_in_days >= 0 && draft.due_in_days <= 365)) errors.due_in_days = "Enter 0 or more days (up to 365).";
  } else {
    parts.forEach((p, i) => {
      if (!String(p.name ?? "").trim()) errors[`parts.${i}.name`] = "Give this milestone a name.";
      if (!(Number(p.amount) > 0)) errors[`parts.${i}.amount`] = "Amount must be more than 0.";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.due_date ?? "")) errors[`parts.${i}.due_date`] = "Pick a due date.";
      else if (p.due_date < todayIso) errors[`parts.${i}.due_date`] = "This date is in the past.";
      else if (i > 0 && parts[i - 1].due_date && p.due_date < parts[i - 1].due_date) errors[`parts.${i}.due_date`] = "Must be on or after the previous milestone.";
    });
    const sum = parts.reduce((t, p) => t + cents(p.amount), 0);
    const total = cents(formTotal(draft.items));
    if (sum !== total) errors.parts_total = `Milestones add up to ${money(sum / 100, draft.currency)} of ${money(total / 100, draft.currency)}.`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Spreads `total` evenly over the milestones (last takes the rounding), keeping names and dates. */
export function splitEvenly(parts, total) {
  const n = parts.length;
  const each = Math.floor(cents(total) / n);
  return parts.map((p, i) => ({ ...p, amount: (i === n - 1 ? cents(total) - each * (n - 1) : each) / 100 }));
}
