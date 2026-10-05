// Connecting a client's AI agent: the client approves CollectPilot once on PayPal,
// we keep the reusable PayPal token, and hand the client an agent key (shown once).
import { createHash, randomBytes } from "node:crypto";

export const SPEND_LIMITS = [250, 500, 1000];
const PENDING_TTL_MS = 60 * 60 * 1000;

export class ConnectError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const token = (bytes) => randomBytes(bytes).toString("base64url");

/**
 * Starts PayPal approval. Returns the PayPal approval URL and a nonce the caller
 * must keep in an httpOnly cookie; only that browser can complete the connection.
 */
export async function startConnection({ paypal, store, appUrl, invoiceId, spendLimit, now = new Date() }) {
  if (!SPEND_LIMITS.includes(spendLimit)) throw new ConnectError("BAD_LIMIT", "Choose one of the offered limits.");
  const st = await paypal.request("POST", "/v3/vault/setup-tokens", {
    payment_source: {
      paypal: {
        description: `Lets your AI agent pay CollectPilot invoices addressed to you, up to ${spendLimit} USD each`,
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        permit_multiple_payment_tokens: true,
        experience_context: {
          brand_name: "CollectPilot",
          return_url: `${appUrl}/connect/return`,
          cancel_url: `${appUrl}/connect/cancelled`,
        },
      },
    },
  });
  const approveUrl = st.links?.find((l) => l.rel === "approve")?.href;
  if (!approveUrl) throw new ConnectError("PAYPAL_UNAVAILABLE", "PayPal did not return an approval link.");

  const nonce = token(32);
  await store.insertPending({
    setupTokenId: st.id,
    nonceHash: sha256(nonce),
    invoiceId: invoiceId || null,
    spendLimit,
    expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
  });
  return { approveUrl, nonce };
}

/** Finishes the connection for the browser holding `nonce`. Returns the new payer and its agent key. */
export async function completeConnection({ paypal, store, nonce, now = new Date() }) {
  const pending = nonce ? await store.findPending(sha256(nonce)) : null;
  if (!pending) throw new ConnectError("NO_PENDING", "We couldn't find an approval started in this browser.");
  if (pending.usedAt) throw new ConnectError("ALREADY_USED", "This approval was already completed.");
  if (pending.expiresAt <= now) throw new ConnectError("EXPIRED", "This approval expired. Please start again.");

  const st = await paypal.request("GET", `/v3/vault/setup-tokens/${encodeURIComponent(pending.setupTokenId)}`);
  if (st.status !== "APPROVED") throw new ConnectError("NOT_APPROVED", "PayPal has not confirmed the approval.");

  const pt = await paypal.request("POST", "/v3/vault/payment-tokens", {
    payment_source: { token: { id: pending.setupTokenId, type: "SETUP_TOKEN" } },
  });
  const paypalEmail = pt.payment_source?.paypal?.email_address;
  if (!pt.id || !paypalEmail) throw new ConnectError("PAYPAL_UNAVAILABLE", "PayPal did not return the saved account.");

  const agentKey = `cp_agent_${token(24)}`;
  const payer = await store.insertPayer({
    paypalEmail,
    vaultId: pt.id,
    agentKeyHash: sha256(agentKey),
    spendLimit: pending.spendLimit,
    invoiceId: pending.invoiceId,
  });
  await store.markPendingUsed(pending.id);
  return { payer, agentKey };
}

/** Looks up the active payer behind an agent key. */
export async function payerForKey({ store, agentKey }) {
  if (!agentKey?.startsWith("cp_agent_")) return null;
  return store.findActivePayerByKeyHash(sha256(agentKey));
}

/** Deletes the PayPal token and disables the agent key. */
export async function revokeConnection({ paypal, store, payerId }) {
  const payer = await store.findPayer(payerId);
  if (!payer || payer.status !== "active") return false;
  try {
    await paypal.request("DELETE", `/v3/vault/payment-tokens/${encodeURIComponent(payer.vaultId)}`);
  } catch (err) {
    // Already gone at PayPal is fine; anything else must not leave the key active silently.
    if (!/404/.test(err.message)) throw err;
  }
  await store.revokePayer(payerId);
  return true;
}
