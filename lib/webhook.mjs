// PayPal webhook handling, independent of the HTTP framework.

export const MAX_BODY = 1_000_000;

const SIG_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
];

// Pulls the fields the dashboard needs from INVOICING.* events.
export function summarize(event, receivedAt = new Date()) {
  const r = event.resource ?? {};
  const inv = r.invoice ?? r;
  return {
    id: event.id,
    event_type: event.event_type,
    invoice_id: inv.id ?? null,
    invoice_number: inv.detail?.invoice_number ?? null,
    client: inv.primary_recipients?.[0]?.billing_info?.email_address ?? null,
    status: inv.status ?? null,
    amount: inv.amount?.value ?? null,
    currency: inv.amount?.currency_code ?? null,
    due_date: inv.detail?.payment_term?.due_date ?? null,
    received_at: receivedAt.toISOString(),
  };
}

/**
 * @param {{ headers: Record<string, string>, rawBody: string, webhookId: string,
 *   paypal: { verifyWebhookSignature: Function } }} input
 * @returns {Promise<{ status: number, body: object, summary?: object, event?: { id: string, event_type: string } }>}
 */
export async function handleWebhook({ headers, rawBody, webhookId, paypal }) {
  if (!webhookId) return { status: 503, body: { error: "webhook id not configured" } };
  if (SIG_HEADERS.some((h) => !headers[h])) return { status: 400, body: { error: "missing PayPal signature headers" } };
  if (Buffer.byteLength(rawBody) > MAX_BODY) return { status: 413, body: { error: "body too large" } };

  const verified = await paypal.verifyWebhookSignature({ headers, rawBody, webhookId });
  if (!verified) return { status: 401, body: { error: "signature not verified" } };

  const event = JSON.parse(rawBody);
  return { status: 200, body: { ok: true }, event, summary: summarize(event) };
}
