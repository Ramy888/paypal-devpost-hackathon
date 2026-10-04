// Runs a folder of the spike-1 collection with Newman, feeding secrets from .env.
// Usage: node --env-file=.env postman/run.mjs "1a · create and send" [invoice_id=INV2-...]
import newman from "newman";

const [folder, ...extra] = process.argv.slice(2);
const required = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_API_BASE"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}

const envVar = [
  { key: "api_base", value: process.env.PAYPAL_API_BASE },
  { key: "client_id", value: process.env.PAYPAL_CLIENT_ID },
  { key: "client_secret", value: process.env.PAYPAL_CLIENT_SECRET },
  { key: "buyer_email", value: process.env.PAYPAL_SANDBOX_BUYER_EMAIL ?? "" },
  { key: "webhook_url", value: process.env.WEBHOOK_URL ?? "" },
  ...extra.map((kv) => {
    const [key, ...rest] = kv.split("=");
    return { key, value: rest.join("=") };
  }),
];

newman.run(
  {
    collection: new URL("./collectpilot-spike1.postman_collection.json", import.meta.url).pathname,
    folder,
    envVar,
    reporters: ["cli"],
  },
  (err, summary) => {
    if (err) throw err;
    process.exitCode = summary.run.failures.length ? 1 : 0;
  },
);
