// Minimal PayPal REST client: cached OAuth token, one retry on stale scopes,
// and webhook signature verification.

const EXPIRY_MARGIN_MS = 60_000;

export function createPayPalClient({ apiBase, clientId, clientSecret, fetch = globalThis.fetch }) {
  const basic = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let cached = null; // { token, expiresAt }

  async function getToken() {
    if (cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) return cached.token;
    const res = await fetch(`${apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const json = await res.json();
    if (!res.ok || !json.access_token) throw new Error(`PayPal token request failed: ${res.status} ${json.error ?? ""}`);
    cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return cached.token;
  }

  // PayPal keeps returning the same token until it expires, and a token's scopes
  // are fixed when it is issued. Revoking it forces a token with current scopes.
  async function revokeToken() {
    if (!cached) return;
    const token = cached.token;
    cached = null;
    await fetch(`${apiBase}/v1/oauth2/token/terminate`, {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}&token_type_hint=ACCESS_TOKEN`,
    });
  }

  async function send(method, path, body, rawBody, extraHeaders) {
    const token = await getToken();
    return fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...extraHeaders,
      },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  }

  async function request(method, path, body, { rawBody, headers } = {}) {
    let res = await send(method, path, body, rawBody, headers);
    if (res.status === 403 && (await res.clone().json().catch(() => ({}))).name === "NOT_AUTHORIZED") {
      await revokeToken();
      res = await send(method, path, body, rawBody, headers);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`PayPal ${method} ${path} failed: ${res.status} ${json.name ?? ""}`.trim());
    return json;
  }

  // The event is spliced in as raw text: re-serialising it can change bytes and
  // make PayPal report FAILURE for a genuine notification.
  async function verifyWebhookSignature({ headers, rawBody, webhookId }) {
    const h = (name) => headers[name] ?? "";
    const prefix = JSON.stringify({
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: webhookId,
    }).slice(0, -1);
    const payload = `${prefix},"webhook_event":${rawBody}}`;
    const json = await request("POST", "/v1/notifications/verify-webhook-signature", undefined, { rawBody: payload });
    return json.verification_status === "SUCCESS";
  }

  return { getToken, request, verifyWebhookSignature };
}
