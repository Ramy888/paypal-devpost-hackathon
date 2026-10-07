// CollectPilot Pro: the app's own $12/month plan, billed with PayPal Subscriptions.
// One freelancer per deployment, so the plan state lives in app_settings.
import { verifyReturn } from "./retainers.mjs";

export const PRO = { amount: 12, currency: "USD", name: "CollectPilot Pro" };
export const PRO_FEATURES = [
  "Monthly retainers for repeat clients, billed by PayPal",
  "Reminder autopilot: drafts go out on schedule unless you change them",
];

const K = {
  product: "pro_product_id",
  plan: "pro_plan_id",
  subscription: "pro_subscription_id",
  status: "pro_status",
  payments: "pro_payments_count",
  lastSale: "pro_last_sale_id",
};

/** @returns {Promise<{ status: string, planId: string | null, subscriptionId: string | null, paymentsCount: number, lastSaleId: string | null }>} */
export async function proState(store) {
  const [status, planId, subscriptionId, payments, lastSaleId] = await Promise.all(
    [K.status, K.plan, K.subscription, K.payments, K.lastSale].map((k) => store.getSetting(k)),
  );
  return { status: status ?? "free", planId, subscriptionId, paymentsCount: Number(payments ?? 0), lastSaleId };
}

export const isPro = (state) => state.status === "active";

async function ensurePlan({ paypal, store }) {
  const saved = await store.getSetting(K.plan);
  if (saved) return saved;
  let productId = await store.getSetting(K.product);
  if (!productId) {
    const product = await paypal.request(
      "POST",
      "/v1/catalogs/products",
      { name: PRO.name, type: "SERVICE", category: "SOFTWARE" },
      { headers: { "PayPal-Request-Id": "collectpilot-pro-product" } },
    );
    productId = product.id;
    await store.setSetting(K.product, productId);
  }
  const plan = await paypal.request(
    "POST",
    "/v1/billing/plans",
    {
      product_id: productId,
      name: `${PRO.name} monthly`,
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: PRO.amount.toFixed(2), currency_code: PRO.currency } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
    },
    { headers: { "PayPal-Request-Id": "collectpilot-pro-plan" } },
  );
  await store.setSetting(K.plan, plan.id);
  return plan.id;
}

/** Freelancer clicked "Upgrade": create the subscription and return PayPal's approval link. */
export async function startPro({ paypal, store, appUrl, now = new Date() }) {
  const state = await proState(store);
  if (isPro(state)) throw new Error("You're already on Pro.");
  const planId = await ensurePlan({ paypal, store });
  // Same request id for ten minutes, so a double click can't create two subscriptions.
  const bucket = Math.floor(now.getTime() / 600_000);
  const sub = await paypal.request(
    "POST",
    "/v1/billing/subscriptions",
    {
      plan_id: planId,
      custom_id: "collectpilot-pro",
      application_context: {
        brand_name: "CollectPilot",
        user_action: "SUBSCRIBE_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: `${appUrl}/billing/return`,
        cancel_url: `${appUrl}/billing?cancelled=1`,
      },
    },
    { headers: { "PayPal-Request-Id": `collectpilot-pro-sub-${bucket}` } },
  );
  const approve = sub.links?.find((l) => l.rel === "approve")?.href;
  if (!approve) throw new Error("PayPal did not return an approval link.");
  await store.setSetting(K.subscription, sub.id);
  await store.setSetting(K.status, "pending");
  return approve;
}

/** Return from PayPal: trust only a fresh read of the subscription we created. */
export async function confirmPro({ paypal, store, returnedId }) {
  const state = await proState(store);
  if (!state.subscriptionId || returnedId !== state.subscriptionId) return { ok: false, reason: "NOT_THIS_SUBSCRIPTION" };
  const subscription = await paypal.request("GET", `/v1/billing/subscriptions/${encodeURIComponent(state.subscriptionId)}`);
  const check = verifyReturn({ retainer: { subscriptionId: state.subscriptionId, planId: state.planId }, subscription });
  if (check.ok) await store.setSetting(K.status, "active");
  return check;
}

/** Subscription webhook for the Pro plan. Returns false when the event is about another subscription. */
export async function applyProEvent({ store, ev }) {
  const state = await proState(store);
  if (!ev || !state.subscriptionId || ev.subscriptionId !== state.subscriptionId) return false;
  if (ev.saleId) {
    if (ev.saleId !== state.lastSaleId) {
      await store.setSetting(K.payments, state.paymentsCount + 1);
      await store.setSetting(K.lastSale, ev.saleId);
    }
  } else if (state.status !== "cancelled") {
    await store.setSetting(K.status, ev.status);
  }
  return true;
}

export async function cancelPro({ paypal, store }) {
  const state = await proState(store);
  if (state.subscriptionId && ["active", "suspended"].includes(state.status)) {
    await paypal.request("POST", `/v1/billing/subscriptions/${encodeURIComponent(state.subscriptionId)}/cancel`, {
      reason: "Cancelled from CollectPilot billing",
    });
  }
  await store.setSetting(K.status, "cancelled");
}
