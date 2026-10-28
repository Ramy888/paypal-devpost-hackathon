// Brings the sandbox data to a clean demo state. Dry run by default; pass --apply to write.
//   node --env-file=.env scripts/demo-reset.mjs [--apply]
// Hides test invoices (sent sandbox invoices can't be deleted), zeroes payer counters
// and resets the demo clock. PayPal itself is only read.
import { createPayPalClient } from "../lib/paypal.mjs";
import { HIDDEN_KEY, isTestInvoice } from "../lib/invoices.mjs";
import { pool, pgStore } from "../lib/server/db.mjs";

const apply = process.argv.includes("--apply");
const pp = createPayPalClient({
  apiBase: process.env.PAYPAL_API_BASE,
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
});
const db = pool();
try {
  const { items = [] } = await pp.request("GET", "/v2/invoicing/invoices?page_size=100&total_required=true");
  const hidden = items.filter(isTestInvoice);
  console.log(`Hide ${hidden.length} test invoices, keep ${items.length - hidden.length}:`);
  for (const inv of items) console.log(`  ${hidden.includes(inv) ? "hide" : "keep"}  ${inv.detail.invoice_number}  ${inv.status}  ${inv.amount?.value}`);
  const { rows } = await db.query("SELECT count(*)::int n FROM payers WHERE payments_count > 0 OR paid_total > 0");
  console.log(`Zero the payment counters of ${rows[0].n} payers; set the demo clock to today.`);
  if (!apply) {
    console.log("Dry run. Pass --apply to write.");
  } else {
    const store = pgStore(db);
    await store.setSetting(HIDDEN_KEY, JSON.stringify(hidden.map((inv) => inv.id)));
    await db.query("UPDATE payers SET payments_count = 0, paid_total = 0 WHERE payments_count > 0 OR paid_total > 0");
    await store.setSetting("clock_offset_days", 0);
    console.log("Applied.");
  }
} finally {
  await db.end();
}
