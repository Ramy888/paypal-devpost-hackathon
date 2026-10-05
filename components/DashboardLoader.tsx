"use client";

import dynamic from "next/dynamic";
import type { InvoiceRow } from "./ReceivablesDashboard";

// AG Studio touches the DOM on load, so it renders only in the browser.
const ReceivablesDashboard = dynamic(() => import("./ReceivablesDashboard"), {
  ssr: false,
  loading: () => <p className="p-8 text-sm text-zinc-500">Loading receivables…</p>,
});

export default function DashboardLoader({ rows, nowIso }: { rows: InvoiceRow[]; nowIso: string }) {
  return <ReceivablesDashboard initialRows={rows} nowIso={nowIso} />;
}
