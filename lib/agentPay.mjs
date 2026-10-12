// What a client's AI agent may do: list what its owner owes, and pay one invoice
// with the owner's pre-approved PayPal token, within a spending limit.
import { ApiError, CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { daysOverdue } from "./invoices.mjs";

const PAYABLE = ["SENT", "UNPAID", "PARTIALLY_PAID"];

// The digest reads this note back to credit the payment to the client's agent.
export const AGENT_NOTE_PREFIX = "Paid by the client's agent:";
export const AUTOPAY_NOTE_PREFIX = "Paid by auto-pay:";

export class AgentPayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const recipientOf = (inv) => inv.primary_recipients?.[0]?.billing_info?.email_address?.toLowerCase() ?? "";
const amountDue = (inv) => inv.due_amount ?? inv.amount;

export async function whatDoIOwe({ paypal, payerEmail, now = new Date() }) {
  const res = await paypal.request("POST", "/v2/invoicing/search-invoices?page=1&page_size=50&total_required=true", {
    recipient_email: payerEmail,
    status: PAYABLE,
  });
  return (res.items ?? [])
    .filter((inv) => recipientOf(inv) === payerEmail.toLowerCase())
    .map((inv) => {
      const due = inv.detail?.payment_term?.due_date ?? null;
      return {
        invoice_id: inv.id,
        invoice_number: inv.detail?.invoice_number ?? null,
        from: inv.invoicer?.business_name ?? inv.invoicer?.email_address ?? null,
        amount_due: amountDue(inv)?.value ?? null,
        currency: amountDue(inv)?.currency_code ?? null,
        due_date: due,
        days_overdue: daysOverdue(due, inv.status, now),
        note: inv.detail?.note ?? null,
      };
    })
    .sort((a, b) => b.days_overdue - a.days_overdue);
}

/**
 * Pays one invoice with the payer's vaulted PayPal token. Every check runs before
 * any money moves; the request id is fixed per invoice so a retried call cannot
 * capture twice.
 */
const RETRY_SAFE = "The payment may have gone through. Retrying this invoice is safe: it will not charge twice.";
// PayPal's specific reason (details[0].issue, e.g. DUPLICATE_INVOICE_ID), else its error name.
const errorName = (err) => {
  try {
    const body = err.result ?? JSON.parse(String(err.body));
    return body.details?.[0]?.issue ?? body.name;
  } catch {
    return undefined;
  }
};

// Only say "nothing was charged" when PayPal rejected the request outright. A 5xx, an in-progress
// duplicate, a timeout or a dropped connection can all follow a capture.
function paymentError(err) {
  if (err instanceof ApiError && err.statusCode < 500 && errorName(err) !== "PREVIOUS_REQUEST_IN_PROGRESS") {
    return new AgentPayError("PAYMENT_FAILED", `PayPal refused the payment (HTTP ${err.statusCode} ${errorName(err) ?? ""}). Nothing was charged.`.replace(" )", ")"));
  }
  const what = err instanceof ApiError ? `PayPal answered HTTP ${err.statusCode}` : `PayPal didn't answer (${err?.message ?? err})`;
  return new AgentPayError("PAYMENT_UNCONFIRMED", `${what}. ${RETRY_SAFE}`);
}

const fixed2 = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

/**
 * Checks an amount the payer asked for against the invoice: at most what is due, and a part
 * payment only where the invoice allows it and at least its minimum. Returns the value to charge.
 */
export function amountToCharge(inv, requested) {
  const due = amountDue(inv);
  const dueValue = Number(due?.value);
  if (!(dueValue > 0)) throw new AgentPayError("NOTHING_DUE", "No amount is due on this invoice.");
  if (requested === undefined || requested === null || Number(requested) === dueValue) return fixed2(dueValue);
  const want = Number(requested);
  if (!(want > 0)) throw new AgentPayError("BAD_AMOUNT", "The amount must be more than zero.");
  if (want > dueValue) throw new AgentPayError("BAD_AMOUNT", `Only ${due.value} ${due.currency_code} is due on this invoice.`);
  const partial = inv.configuration?.partial_payment;
  if (!partial?.allow_partial_payment) throw new AgentPayError("PARTIAL_NOT_ALLOWED", "This invoice must be paid in full.");
  const min = Number(partial.minimum_amount_due?.value ?? 0);
  if (want < min) throw new AgentPayError("BAD_AMOUNT", `The smallest part payment on this invoice is ${partial.minimum_amount_due.value} ${due.currency_code}.`);
  return fixed2(want);
}

/**
 * Charges `value` on an invoice with a saved PayPal token, records it on the invoice and pushes
 * the update to open dashboards. Callers do their own authorisation checks first.
 */
// `noteSuffix` lets a caller tag the payment note (e.g. with a schedule part) to find it again later.
export async function chargeInvoice({ paypal, orders, inv, vaultId, value, notePrefix = AGENT_NOTE_PREFIX, noteSuffix = "", eventStore, now = new Date() }) {
  const currency = amountDue(inv).currency_code;
  // PayPal requires a unique invoice id per payment, so a later part of the same invoice gets a suffix.
  const n = (inv.payments?.transactions?.length ?? 0) + 1;
  const number = inv.detail?.invoice_number;
  let order;
  try {
    const res = await orders.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: inv.id,
            invoiceId: number && (n === 1 ? number : `${number}-${n}`),
            description: `Payment for invoice ${inv.detail?.invoice_number}`,
            amount: { currencyCode: currency, value },
          },
        ],
        paymentSource: { paypal: { vaultId } },
      },
      // Same id for the same payment: a retried call returns the first order instead of charging
      // twice. Prior payments and the amount are in it so a later partial payment gets its own order.
      paypalRequestId: `collectpilot-pay-${inv.id}-${inv.payments?.transactions?.length ?? 0}-${value}`,
      // Without this PayPal may answer with a minimal body that has no captures.
      prefer: "return=representation",
    });
    order = res.result;
  } catch (err) {
    throw paymentError(err);
  }
  const capture = order.purchaseUnits?.[0]?.payments?.captures?.[0];
  if (capture?.status === "PENDING") {
    throw new AgentPayError("PAYMENT_PENDING", `PayPal is still confirming this payment (capture ${capture.id}). Don't pay it again; it shows as paid once PayPal confirms.`);
  }
  if (order.status !== "COMPLETED" || capture?.status !== "COMPLETED") {
    throw new AgentPayError("PAYMENT_NOT_COMPLETED", `PayPal order ${order.id} is ${order.status}.`);
  }

  // payment_id rejects PayPal capture ids, so the capture is recorded in the note.
  await paypal.request("POST", `/v2/invoicing/invoices/${inv.id}/payments`, {
    method: "PAYPAL",
    payment_date: now.toISOString().slice(0, 10),
    amount: { currency_code: currency, value },
    note: `${notePrefix} PayPal capture ${capture.id} (order ${order.id})${noteSuffix}`,
  });

  // Update open dashboards now; PayPal's own webhook arrives ~20 s later.
  const full = Number(value) >= Number(amountDue(inv).value);
  eventStore?.add({
    id: `CHARGE-${capture.id}`,
    event_type: "APP.INVOICE.PAYMENT",
    invoice_id: inv.id,
    invoice_number: inv.detail?.invoice_number ?? null,
    client: recipientOf(inv),
    status: full ? "MARKED_AS_PAID" : "PARTIALLY_PAID",
    amount: value,
    currency,
    due_date: inv.detail?.payment_term?.due_date ?? null,
    received_at: new Date().toISOString(),
  });

  return {
    paid: true,
    invoice_id: inv.id,
    invoice_number: inv.detail?.invoice_number ?? null,
    amount: value,
    currency,
    paypal_capture_id: capture.id,
  };
}

/**
 * Every check a payer's payment must pass, without charging: the invoice is theirs, payable,
 * the amount is allowed, and it fits the limit (which covers all their payments on that invoice).
 * Returns the invoice and the value to charge. `isHeld` (optional) says whether the client put the
 * invoice's milestone "Not done yet"; a held milestone isn't paid until the client lifts the hold.
 */
export async function preparePayment({ paypal, payer, invoiceId, spendLimit, amount, isHeld = /** @type {(invoiceId: string) => Promise<boolean>} */ (async () => false) }) {
  const inv = await paypal.request("GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);

  if (recipientOf(inv) !== payer.email.toLowerCase()) {
    throw new AgentPayError("NOT_YOUR_INVOICE", "This invoice is not addressed to you.");
  }
  if (await isHeld(inv.id ?? invoiceId)) {
    throw new AgentPayError("ON_HOLD", 'You marked this milestone "Not done yet", so it isn\'t paid. Lift the hold on the schedule page first.');
  }
  if (!PAYABLE.includes(inv.status)) {
    throw new AgentPayError("NOT_PAYABLE", `Invoice is ${inv.status}; nothing to pay.`);
  }
  const value = amountToCharge(inv, amount);
  // The owner's limit is per invoice: part payments the agent already made count toward it.
  const paidByAgent = (inv.payments?.transactions ?? [])
    .filter((t) => (t.note ?? "").startsWith(AGENT_NOTE_PREFIX))
    .reduce((sum, t) => sum + Number(t.amount?.value ?? 0), 0);
  if (paidByAgent + Number(value) > spendLimit) {
    const already = paidByAgent > 0 ? ` (you already paid ${paidByAgent.toFixed(2)} on it)` : "";
    throw new AgentPayError("OVER_LIMIT", `Amount ${value} ${amountDue(inv).currency_code} is over your agent's limit of ${spendLimit} for this invoice${already}. Ask your owner to pay it.`);
  }
  return { inv, value };
}

// `paypal` is the REST client (invoicing); `orders` is the PayPal Server SDK OrdersController.
// `amount` is optional: leave it out to pay everything due, or pay one part of an invoice that allows it.
export async function payInvoice({ paypal, orders, payer, invoiceId, spendLimit, amount, isHeld, eventStore, now = new Date() }) {
  const { inv, value } = await preparePayment({ paypal, payer, invoiceId, spendLimit, amount, isHeld });
  return chargeInvoice({ paypal, orders, inv, vaultId: payer.vaultId, value, eventStore, now });
}
