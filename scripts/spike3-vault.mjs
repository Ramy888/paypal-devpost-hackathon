// Spike 3 probe: can an agent pay a PayPal invoice with no buyer click?
// Flow: buyer approves once (vault setup token) -> we keep a payment token ->
// later payments are charged to that token and reconciled onto the invoice.
//
//   node --env-file=.env scripts/spike3-vault.mjs setup          # prints the one-time approval link
//   node --env-file=.env scripts/spike3-vault.mjs exchange <id>  # setup token -> payment token
//   node --env-file=.env scripts/spike3-vault.mjs pay <vault_id> # new invoice, paid with no approval
import { randomUUID } from "node:crypto";
import { createPayPalClient } from "../lib/paypal.mjs";

const env = process.env;
const pp = createPayPalClient({ apiBase: env.PAYPAL_API_BASE, clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
const APP = "https://collectpilot-webhooks.onrender.com";
const [cmd, arg] = process.argv.slice(2);

if (cmd === "setup") {
  const st = await pp.request("POST", "/v3/vault/setup-tokens", {
    payment_source: {
      paypal: {
        description: "Lets your AI agent pay CollectPilot invoices you owe",
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        permit_multiple_payment_tokens: true,
        experience_context: {
          brand_name: "CollectPilot",
          return_url: `${APP}/healthz?vault=approved`,
          cancel_url: `${APP}/healthz?vault=cancelled`,
        },
      },
    },
  });
  console.log("setup token:", st.id, "status:", st.status);
  console.log("approve link:", st.links?.find((l) => l.rel === "approve")?.href);
} else if (cmd === "exchange") {
  const st = await pp.request("GET", `/v3/vault/setup-tokens/${arg}`);
  console.log("setup token status:", st.status);
  const pt = await pp.request("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: arg, type: "SETUP_TOKEN" } } });
  console.log("payment token (vault id):", pt.id, "| customer:", pt.customer?.id, "| payer:", pt.payment_source?.paypal?.email_address);
} else if (cmd === "pay") {
  const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const inv = await pp.request("POST", "/v2/invoicing/invoices", {
    detail: { currency_code: "USD", invoice_number: "CP-AGENT-" + Date.now(), note: "Spike 3: paid by the client's agent", payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: due } },
    primary_recipients: [{ billing_info: { email_address: env.PAYPAL_SANDBOX_BUYER_EMAIL } }],
    items: [{ name: "Monthly retainer", quantity: "1", unit_amount: { currency_code: "USD", value: "250.00" } }],
  });
  await pp.request("POST", `/v2/invoicing/invoices/${inv.id}/send`, { send_to_recipient: true });
  console.log("invoice:", inv.id, inv.detail.invoice_number, "SENT");

  const t0 = Date.now();
  const order = await pp.request("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: inv.id,
        invoice_id: inv.detail.invoice_number,
        description: `Payment for invoice ${inv.detail.invoice_number}`,
        amount: { currency_code: "USD", value: "250.00" },
      },
    ],
    payment_source: { paypal: { vault_id: arg } },
  }, { headers: { "PayPal-Request-Id": randomUUID() } });
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  console.log("order:", order.id, "status:", order.status, "| capture:", capture?.id, capture?.status, `(${Date.now() - t0} ms, no buyer click)`);
  if (order.status !== "COMPLETED") process.exit(1);

  await pp.request("POST", `/v2/invoicing/invoices/${inv.id}/payments`, {
    // payment_id rejects PayPal capture ids (404), so the capture is kept in the note.
    method: "PAYPAL",
    payment_date: new Date().toISOString().slice(0, 10),
    amount: { currency_code: "USD", value: "250.00" },
    note: `Paid by the client's agent: PayPal capture ${capture.id} (order ${order.id})`,
  });
  const after = await pp.request("GET", `/v2/invoicing/invoices/${inv.id}`);
  console.log("invoice status after reconcile:", after.status);
} else {
  console.log("usage: setup | exchange <setup_token_id> | pay <vault_id>");
}
