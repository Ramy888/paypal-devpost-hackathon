// Retainers: spot clients who keep paying, offer them a monthly PayPal subscription,
// and track it from offer to active. Pure helpers first, then the PayPal calls.
import { isEmail } from "./email.mjs";
import { isPaid } from "./invoices.mjs";

export const OPEN = ["offered", "pending", "active", "suspended"];
const PRODUCT_KEY = "retainer_product_id";

const recipient = (inv) => inv.primary_recipients?.[0]?.billing_info ?? {};
const clientName = (b) => b.business_name || [b.name?.given_name, b.name?.surname].filter(Boolean).join(" ") || b.email_address || "";

/**
 * Clients with at least `minPaid` paid invoices in one currency and no open retainer.
 * Suggested amount: the median paid invoice, rounded to the nearest 10.
 * @param {{ invoices: any[], existing?: { clientEmail: string, status: string }[], minPaid?: number }} input
 */
export function findRetainerCandidates({ invoices, existing = [], minPaid = 2 }) {
  const taken = new Set(existing.filter((r) => OPEN.includes(r.status)).map((r) => r.clientEmail.toLowerCase()));
  const byClient = new Map();
  for (const inv of invoices) {
    const email = recipient(inv).email_address?.toLowerCase();
    if (!email || taken.has(email) || !isPaid(inv.status)) continue;
    byClient.set(email, [...(byClient.get(email) ?? []), inv]);
  }

  const out = [];
  for (const [email, paid] of byClient) {
    const latest = paid.toSorted((a, b) => (b.detail?.invoice_date ?? "").localeCompare(a.detail?.invoice_date ?? ""))[0];
    const currency = latest.amount?.currency_code ?? "USD";
    const amounts = paid
      .filter((i) => (i.amount?.currency_code ?? "USD") === currency)
      .map((i) => Number(i.amount?.value ?? 0))
      .toSorted((a, b) => a - b);
    if (amounts.length < minPaid) continue;
    const mid = amounts.length / 2;
    const median = amounts.length % 2 ? amounts[Math.floor(mid)] : (amounts[mid - 1] + amounts[mid]) / 2;
    out.push({
      clientEmail: email,
      clientName: clientName(recipient(latest)),
      currency,
      paidCount: amounts.length,
      paidTotal: amounts.reduce((s, n) => s + n, 0),
      suggestedAmount: Math.max(10, Math.round(median / 10) * 10),
      lastInvoiceDate: latest.detail?.invoice_date ?? null,
    });
  }
  return out.sort((a, b) => b.paidTotal - a.paidTotal);
}

/** Checks what the freelancer typed before anything reaches PayPal. */
export function validateOffer({ clientEmail, clientName, amount, currency, description }) {
  const errors = [];
  const value = Math.round(Number(amount) * 100) / 100;
  if (!isEmail(clientEmail)) errors.push("a valid client email");
  if (!(value >= 1 && value <= 10_000)) errors.push("a monthly amount between 1 and 10,000");
  if (!/^[A-Z]{3}$/.test(currency ?? "")) errors.push("a 3-letter currency");
  const desc = String(description ?? "").trim();
  if (desc.length < 3 || desc.length > 120) errors.push("what the retainer covers (3 to 120 characters)");
  if (errors.length) return { ok: false, error: `Please add ${errors.join(", ")}.` };
  return {
    ok: true,
    offer: { clientEmail: clientEmail.toLowerCase(), clientName: String(clientName ?? "").trim().slice(0, 80), amount: value, currency, description: desc },
  };
}

export function planBody({ productId, offer, freelancerName }) {
  return {
    product_id: productId,
    name: `${freelancerName} monthly retainer`.slice(0, 127),
    description: offer.description.slice(0, 127),
    status: "ACTIVE",
    billing_cycles: [
      {
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        tenure_type: "REGULAR",
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: offer.amount.toFixed(2), currency_code: offer.currency } },
      },
    ],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
  };
}

// No start_time: PayPal charges the first month as soon as the client approves.
export function subscriptionBody({ retainer, appUrl, freelancerName }) {
  return {
    plan_id: retainer.planId,
    custom_id: retainer.id,
    subscriber: { email_address: retainer.clientEmail },
    application_context: {
      brand_name: freelancerName.slice(0, 127),
      user_action: "SUBSCRIBE_NOW",
      shipping_preference: "NO_SHIPPING",
      return_url: `${appUrl}/retainer/return?r=${retainer.publicId}`,
      cancel_url: `${appUrl}/retainer/${retainer.publicId}?cancelled=1`,
    },
  };
}

/** Never trust the return URL alone: the fetched subscription must be the one we created, for this plan, and running. */
export function verifyReturn({ retainer, subscription }) {
  if (!retainer?.subscriptionId || subscription?.id !== retainer.subscriptionId) return { ok: false, reason: "NOT_THIS_SUBSCRIPTION" };
  if (subscription.plan_id !== retainer.planId) return { ok: false, reason: "WRONG_PLAN" };
  if (subscription.status !== "ACTIVE") return { ok: false, reason: "NOT_ACTIVE", status: subscription.status };
  return { ok: true };
}

/** Subscription webhook → a small change to apply, or null for anything else (e.g. ordinary invoice sales). */
export function subscriptionEvent(event) {
  const r = event?.resource ?? {};
  const states = { "BILLING.SUBSCRIPTION.ACTIVATED": "active", "BILLING.SUBSCRIPTION.CANCELLED": "cancelled", "BILLING.SUBSCRIPTION.SUSPENDED": "suspended" };
  if (states[event?.event_type] && r.id) return { subscriptionId: r.id, status: states[event.event_type] };
  if (event?.event_type === "PAYMENT.SALE.COMPLETED" && r.billing_agreement_id) {
    return { subscriptionId: r.billing_agreement_id, saleId: r.id, amount: Number(r.amount?.total ?? 0) };
  }
  return null;
}

/** What to write to the retainer row for an event; null when nothing changes (unknown sale already counted, closed row). */
export function applySubscriptionEvent(row, ev, now = new Date()) {
  if (ev.saleId) {
    if (ev.saleId === row.lastSaleId) return null;
    return { paymentsCount: row.paymentsCount + 1, paidTotal: row.paidTotal + ev.amount, lastPaymentAt: now, lastSaleId: ev.saleId };
  }
  if (row.status === "cancelled" || row.status === ev.status) return null;
  if (ev.status === "active" && row.status !== "pending" && row.status !== "suspended") return null;
  return { status: ev.status, ...(ev.status === "active" && !row.activatedAt ? { activatedAt: now } : {}) };
}

// ---- PayPal calls (dependencies injected, like the reminder agent) ----

async function ensureProduct({ paypal, store }) {
  const saved = await store.getSetting(PRODUCT_KEY);
  if (saved) return saved;
  const product = await paypal.request(
    "POST",
    "/v1/catalogs/products",
    { name: "CollectPilot retainer", type: "SERVICE", category: "SOFTWARE" },
    { headers: { "PayPal-Request-Id": "collectpilot-retainer-product" } },
  );
  await store.setSetting(PRODUCT_KEY, product.id);
  return product.id;
}

/** Creates the monthly plan and the offer row. The client sees it at /retainer/<publicId>. */
export async function createOffer({ paypal, store, offer, freelancerName, publicId }) {
  const productId = await ensureProduct({ paypal, store });
  const plan = await paypal.request("POST", "/v1/billing/plans", planBody({ productId, offer, freelancerName }), {
    headers: { "PayPal-Request-Id": `collectpilot-plan-${publicId}` },
  });
  return store.insertRetainer({ ...offer, publicId, planId: plan.id });
}

/** Client clicked "Approve": create the subscription and return PayPal's approval link. */
export async function startSubscription({ paypal, store, retainer, appUrl, freelancerName, now = new Date() }) {
  if (!["offered", "pending"].includes(retainer.status)) throw new Error("This offer is no longer open.");
  // Same request id for ten minutes, so a double click can't create two subscriptions.
  const bucket = Math.floor(now.getTime() / 600_000);
  const sub = await paypal.request("POST", "/v1/billing/subscriptions", subscriptionBody({ retainer, appUrl, freelancerName }), {
    headers: { "PayPal-Request-Id": `collectpilot-sub-${retainer.id}-${bucket}` },
  });
  const approve = sub.links?.find((l) => l.rel === "approve")?.href;
  if (!approve) throw new Error("PayPal did not return an approval link.");
  await store.setRetainerSubscription(retainer.id, sub.id);
  return approve;
}

/** Freelancer withdraws an offer or ends a running retainer. */
export async function endRetainer({ paypal, store, retainer }) {
  if (retainer.subscriptionId && ["active", "suspended"].includes(retainer.status)) {
    await paypal.request("POST", `/v1/billing/subscriptions/${encodeURIComponent(retainer.subscriptionId)}/cancel`, {
      reason: "Retainer ended by the freelancer",
    });
  }
  await paypal.request("POST", `/v1/billing/plans/${encodeURIComponent(retainer.planId)}/deactivate`).catch(() => {});
  await store.updateRetainer(retainer.id, { status: "cancelled" });
}
