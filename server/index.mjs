import { createApp } from "./app.mjs";
import { createPayPalClient } from "../lib/paypal.mjs";

const env = process.env;
const missing = ["PAYPAL_API_BASE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ADMIN_TOKEN"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const paypal = createPayPalClient({
  apiBase: env.PAYPAL_API_BASE,
  clientId: env.PAYPAL_CLIENT_ID,
  clientSecret: env.PAYPAL_CLIENT_SECRET,
});

const server = createApp({ paypal, webhookId: env.PAYPAL_WEBHOOK_ID ?? "", adminToken: env.ADMIN_TOKEN });
const port = Number(env.PORT ?? 3000);
server.listen(port, () => console.log(JSON.stringify({ msg: "listening", port, webhook_configured: Boolean(env.PAYPAL_WEBHOOK_ID) })));
