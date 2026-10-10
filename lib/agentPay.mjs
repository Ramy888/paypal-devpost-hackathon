// What a client's AI agent may do: list what its owner owes, and pay one invoice
// with the owner's pre-approved PayPal token, within a spending limit.
import { ApiError, CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { daysOverdue } from "./invoices.mjs";

const PAYABLE = ["SENT", "UNPAID", "PARTIALLY_PAID"];

// The digest reads this note back to credit the payment to the client's agent.
export const AGENT_NOTE_PREFIX = "Paid by the client's agent:";

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
const errorName = (err) => {
  try {
    return err.result?.name ?? JSON.parse(String(err.body)).name;
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

// `paypal` is the REST client (invoicing); `orders` is the PayPal Server SDK OrdersController.
export async function payInvoice({ paypal, orders, payer, invoiceId, spendLimit, eventStore, now = new Date() }) {
  const inv = await paypal.request("GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);

  if (recipientOf(inv) !== payer.email.toLowerCase()) {
    throw new AgentPayError("NOT_YOUR_INVOICE", "This invoice is not addressed to you.");
  }
  if (!PAYABLE.includes(inv.status)) {
    throw new AgentPayError("NOT_PAYABLE", `Invoice is ${inv.status}; nothing to pay.`);
  }
  const due = amountDue(inv);
  const value = Number(due?.value);
  if (!(value > 0)) throw new AgentPayError("NOTHING_DUE", "No amount is due on this invoice.");
  if (value > spendLimit) {
    throw new AgentPayError("OVER_LIMIT", `Amount ${due.value} ${due.currency_code} is over your agent's limit of ${spendLimit}. Ask your owner to pay it.`);
  }

  let order;
  try {
    const res = await orders.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: inv.id,
            invoiceId: inv.detail?.invoice_number,
            description: `Payment for invoice ${inv.detail?.invoice_number}`,
            amount: { currencyCode: due.currency_code, value: due.value },
          },
        ],
        paymentSource: { paypal: { vaultId: payer.vaultId } },
      },
      // Same id for the same payment: a retried call returns the first order instead of charging
      // twice. Prior payments and the amount are in it so a later partial payment gets its own order.
      paypalRequestId: `collectpilot-pay-${inv.id}-${inv.payments?.transactions?.length ?? 0}-${due.value}`,
      // Without this PayPal may answer with a minimal body that has no captures.
      prefer: "return=representation",
    });
    order = res.result;
  } catch (err) {
    throw paymentError(err);
  }
  const capture = order.purchaseUnits?.[0]?.payments?.captures?.[0];
  if (order.status !== "COMPLETED" || capture?.status !== "COMPLETED") {
    throw new AgentPayError("PAYMENT_NOT_COMPLETED", `PayPal order ${order.id} is ${order.status}.`);
  }

  // payment_id rejects PayPal capture ids, so the capture is recorded in the note.
  await paypal.request("POST", `/v2/invoicing/invoices/${inv.id}/payments`, {
    method: "PAYPAL",
    payment_date: now.toISOString().slice(0, 10),
    amount: { currency_code: due.currency_code, value: due.value },
    note: `${AGENT_NOTE_PREFIX} PayPal capture ${capture.id} (order ${order.id})`,
  });

  // Update open dashboards now; PayPal's own webhook arrives ~20 s later.
  eventStore?.add({
    id: `AGENT-${capture.id}`,
    event_type: "AGENT.INVOICE.PAID",
    invoice_id: inv.id,
    invoice_number: inv.detail?.invoice_number ?? null,
    client: recipientOf(inv),
    status: "MARKED_AS_PAID",
    amount: due.value,
    currency: due.currency_code,
    due_date: inv.detail?.payment_term?.due_date ?? null,
    received_at: new Date().toISOString(),
  });

  return {
    paid: true,
    invoice_id: inv.id,
    invoice_number: inv.detail?.invoice_number ?? null,
    amount: due.value,
    currency: due.currency_code,
    paypal_capture_id: capture.id,
  };
}
