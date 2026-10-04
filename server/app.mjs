import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const MAX_BODY = 1_000_000;
const KEEP_EVENTS = 50;
const SIG_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
];

class BodyTooLarge extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > MAX_BODY) return reject(new BodyTooLarge());
    const chunks = [];
    let size = 0;
    // Oversized chunked bodies are drained and discarded so the 413 can still be sent.
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => (size > MAX_BODY ? reject(new BodyTooLarge()) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

function sameToken(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Pulls the fields we care about from INVOICING.* (and payment) events.
function summarize(event) {
  const r = event.resource ?? {};
  const inv = r.invoice ?? r;
  return {
    id: event.id,
    event_type: event.event_type,
    invoice_id: inv.id ?? null,
    status: inv.status ?? null,
    amount: inv.amount?.value ?? null,
    currency: inv.amount?.currency_code ?? null,
    received_at: new Date().toISOString(),
  };
}

export function createApp({ paypal, webhookId, adminToken, log = console.log }) {
  const events = [];

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  async function handleWebhook(req, res) {
    if (!webhookId) return send(res, 503, { error: "webhook id not configured" });
    if (SIG_HEADERS.some((h) => !req.headers[h])) return send(res, 400, { error: "missing PayPal signature headers" });

    const rawBody = await readBody(req);
    const verified = await paypal.verifyWebhookSignature({ headers: req.headers, rawBody, webhookId });
    if (!verified) {
      log(JSON.stringify({ msg: "webhook signature rejected", transmission_id: req.headers["paypal-transmission-id"] }));
      return send(res, 401, { error: "signature not verified" });
    }

    const summary = summarize(JSON.parse(rawBody));
    events.unshift(summary);
    events.length = Math.min(events.length, KEEP_EVENTS);
    log(JSON.stringify({ msg: "webhook verified", ...summary }));
    send(res, 200, { ok: true });
  }

  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && pathname === "/healthz") return send(res, 200, { ok: true });
      if (req.method === "POST" && pathname === "/webhooks/paypal") return await handleWebhook(req, res);
      if (req.method === "GET" && pathname === "/events") {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!sameToken(token, adminToken)) return send(res, 401, { error: "unauthorized" });
        return send(res, 200, events);
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof BodyTooLarge) return send(res, 413, { error: "body too large" });
      log(JSON.stringify({ msg: "request failed", path: pathname, error: err.message }));
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  });
}
