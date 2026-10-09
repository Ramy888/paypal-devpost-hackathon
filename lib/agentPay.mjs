// What a client's AI agent may do: list what its owner owes, and pay one invoice
// with the owner's pre-approved PayPal token, within a spending limit.
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
export async function payInvoice({ paypal, payer, invoiceId, spendLimit, eventStore, now = new Date() }) {
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

  const order = await paypal.request(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: inv.id,
          invoice_id: inv.detail?.invoice_number,
          description: `Payment for invoice ${inv.detail?.invoice_number}`,
          amount: { currency_code: due.currency_code, value: due.value },
        },
      ],
      payment_source: { paypal: { vault_id: payer.vaultId } },
    },
    { headers: { "PayPal-Request-Id": `collectpilot-pay-${inv.id}` } },
  );
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
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
