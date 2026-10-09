import { connection } from "next/server";
import DashboardLoader from "@/components/DashboardLoader";
import type { InvoiceRow } from "@/components/ReceivablesDashboard";
import { toRow } from "@/lib/invoices.mjs";
import { paypal } from "@/lib/server/paypal";
import { now } from "@/lib/server/clock.mjs";
import { redirect } from "next/navigation";
import { isOwner } from "@/lib/server/owner";

// Clearly fake rows for load testing: /?synthetic=1000. Built as PayPal invoices so
// risk, expected date and tile amounts follow the same rules as real rows.
function syntheticRows(count: number, today: Date): InvoiceRow[] {
  return Array.from({ length: count }, (_, i) => {
    const due = new Date(today.getTime() + (10 - (i % 30)) * 86_400_000).toISOString().slice(0, 10);
    return toRow(
      {
        id: `SYNTH-${i}`,
        status: i % 3 === 0 ? "PAID" : "SENT",
        amount: { value: String(100 + ((i * 37) % 2400)), currency_code: "USD" },
        detail: { invoice_number: `SYNTH-${String(i).padStart(4, "0")}`, payment_term: { due_date: due } },
        primary_recipients: [{ billing_info: { email_address: `synthetic-${i % 40}@example.test` } }],
      },
      today,
    );
  });
}

export default async function Home({ searchParams }: PageProps<"/">) {
  await connection();
  if (!(await isOwner())) redirect("/login");
  const { synthetic } = await searchParams;
  const list = await paypal().request("GET", "/v2/invoicing/invoices?page_size=100&total_required=true");
  const today = await now();
  const real: InvoiceRow[] = (list.items ?? []).map((inv: unknown) => toRow(inv, today));
  const extra = Math.min(Number(synthetic) || 0, 5000);
  return <DashboardLoader rows={[...real, ...syntheticRows(extra, today)]} nowIso={today.toISOString()} />;
}
