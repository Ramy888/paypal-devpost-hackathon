import { createPayPalClient } from "@/lib/paypal.mjs";
import { createOrdersApi } from "@/lib/paypalOrders.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { HIDDEN_KEY, withoutHidden } from "@/lib/invoices.mjs";

type PayPalClient = ReturnType<typeof createPayPalClient>;
const g = globalThis as typeof globalThis & { __collectpilotPayPal?: PayPalClient };

// One client per process so the OAuth token cache is shared across routes.
export function paypal(): PayPalClient {
  g.__collectpilotPayPal ??= createPayPalClient({
    apiBase: process.env.PAYPAL_API_BASE!,
    clientId: process.env.PAYPAL_CLIENT_ID!,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  });
  return g.__collectpilotPayPal;
}

type OrdersApi = ReturnType<typeof createOrdersApi>;
const go = globalThis as typeof globalThis & { __collectpilotOrders?: OrdersApi };

// The SDK Orders API borrows the REST client's token, so the process keeps one token cache.
export function paypalOrders(): OrdersApi {
  go.__collectpilotOrders ??= createOrdersApi({ apiBase: process.env.PAYPAL_API_BASE ?? "", auth: paypal() });
  return go.__collectpilotOrders;
}

// PayPal's invoice list without the test invoices the demo reset hid.
export async function listInvoices(query = "page_size=100&total_required=true") {
  const [list, hidden] = await Promise.all([
    paypal().request("GET", `/v2/invoicing/invoices?${query}`),
    process.env.DATABASE_URL ? pgStore().getSetting(HIDDEN_KEY) : null,
  ]);
  return { ...list, items: withoutHidden(list.items ?? [], hidden) };
}
