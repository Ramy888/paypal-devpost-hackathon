import { randomBytes } from "node:crypto";
import { toPayPalInvoice, InvoiceInputError } from "@/lib/invoiceSpec.mjs";
import { eventStore } from "@/lib/events.mjs";
import { paypal } from "@/lib/server/paypal";
import { isOwner } from "@/lib/server/owner";

// Creates and sends the PayPal invoice for a draft the freelancer approved.
export async function POST(req: Request) {
  if (!(await isOwner())) return Response.json({ error: "Sign in first." }, { status: 401 });
  const draft = await req.json().catch(() => null);
  const stamp = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  const invoiceNumber = `RVS-${stamp}-${randomBytes(2).toString("hex").toUpperCase()}`;
  try {
    const body = toPayPalInvoice(draft, {
      freelancerName: process.env.FREELANCER_NAME ?? "Your freelancer",
      invoiceNumber,
      appUrl: process.env.APP_URL!,
    });
    const created = await paypal().request("POST", "/v2/invoicing/invoices", body);
    await paypal().request("POST", `/v2/invoicing/invoices/${created.id}/send`, { send_to_recipient: true });

    // Show it on open dashboards now; PayPal's webhook confirms later.
    eventStore.add({
      id: `SENT-${created.id}`,
      event_type: "APP.INVOICE.SENT",
      invoice_id: created.id,
      invoice_number: invoiceNumber,
      client: draft.client_email,
      status: "SENT",
      amount: created.amount?.value ?? null,
      currency: created.amount?.currency_code ?? draft.currency,
      due_date: body.detail.payment_term.due_date,
      received_at: new Date().toISOString(),
    });
    return Response.json({ id: created.id, invoice_number: invoiceNumber, amount: created.amount, due_date: body.detail.payment_term.due_date });
  } catch (err) {
    if (err instanceof InvoiceInputError) return Response.json({ error: err.message }, { status: 400 });
    console.error(JSON.stringify({ msg: "invoice create failed", error: String(err) }));
    return Response.json({ error: "PayPal didn't accept the invoice. Nothing was sent. Try again in a minute." }, { status: 502 });
  }
}
