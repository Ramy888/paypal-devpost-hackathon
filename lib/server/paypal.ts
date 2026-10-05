import { createPayPalClient } from "@/lib/paypal.mjs";

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
