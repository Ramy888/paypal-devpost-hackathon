import { connection } from "next/server";
import DashboardLoader from "@/components/DashboardLoader";
import type { InvoiceRow } from "@/components/ReceivablesDashboard";
import { toRow } from "@/lib/invoices.mjs";
import { paypal } from "@/lib/server/paypal";
import { now } from "@/lib/server/clock.mjs";
import { redirect } from "next/navigation";
import { isOwner } from "@/lib/server/owner";

// Clearly fake rows for load testing: /?synthetic=1000
function syntheticRows(count: number): InvoiceRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `SYNTH-${i}`,
    invoice_number: `SYNTH-${String(i).padStart(4, "0")}`,
    client: `synthetic-${i % 40}@example.test`,
    amount: 100 + ((i * 37) % 2400),
    currency: "USD",
    status: i % 3 === 0 ? "PAID" : "SENT",
    paid: i % 3 === 0,
    due_date: "2026-10-18",
    days_overdue: i % 3 === 0 ? 0 : i % 30,
  }));
}

export default async function Home({ searchParams }: PageProps<"/">) {
  await connection();
  if (!(await isOwner())) redirect("/login");
  const { synthetic } = await searchParams;
  const list = await paypal().request("GET", "/v2/invoicing/invoices?page_size=100&total_required=true");
  const today = await now();
  const real: InvoiceRow[] = (list.items ?? []).map((inv: unknown) => toRow(inv, today));
  const extra = Math.min(Number(synthetic) || 0, 5000);
  return <DashboardLoader rows={[...real, ...syntheticRows(extra)]} nowIso={today.toISOString()} />;
}
