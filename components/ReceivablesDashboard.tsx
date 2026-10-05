"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AgStudio } from "ag-studio-react";
import type { AgReportState } from "ag-studio";
import { applyEvent } from "@/lib/invoices.mjs";

export type InvoiceRow = {
  id: string;
  invoice_number: string;
  client: string;
  amount: number;
  currency: string;
  status: string;
  paid: boolean;
  due_date: string;
  days_overdue: number;
};

type LiveEvent = { invoice_id: string; status: string; received_at: string };

const FIELDS = [
  { id: "invoice_number", name: "Invoice", format: "textFormat" },
  { id: "client", name: "Client", format: "textFormat" },
  { id: "amount", name: "Amount", format: "currencyFormat" },
  { id: "status", name: "Status", format: "textFormat" },
  { id: "due_date", name: "Due", format: "textFormat" },
  { id: "days_overdue", name: "Days overdue", format: "integerFormat" },
] as const;

// One stable array: Studio ignores field changes after the first render.
const SOURCE_FIELDS = [...FIELDS];

const INITIAL_STATE: AgReportState = {
  selectedPageId: "receivables",
  pages: [
    {
      id: "receivables",
      widgets: {
        invoices: {
          type: "grid",
          dataMapping: { cols: FIELDS.map((f) => ({ id: `invoices.${f.id}` })) },
          format: { title: { enabled: true, text: "Receivables" } },
        },
      },
      widgetLayout: { invoices: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 30 } },
    },
  ],
};

// nowIso is the server's demo-clock "today", so days overdue match what the agent sees.
export default function ReceivablesDashboard({ initialRows, nowIso }: { initialRows: InvoiceRow[]; nowIso: string }) {
  const [rows, setRows] = useState(initialRows);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const [studioState, setStudioState] = useState<AgReportState>(INITIAL_STATE);
  const stateRef = useRef<AgReportState>(INITIAL_STATE);
  const [lastUpdate, setLastUpdate] = useState<{ invoice: string; status: string; lagMs: number } | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (msg) => {
      const ev: LiveEvent = JSON.parse(msg.data);
      setRows((prev) => applyEvent(prev, ev, new Date(nowIso)));
      setStudioState(stateRef.current);
      setVersion((v) => v + 1);
      setLastUpdate({ invoice: ev.invoice_id, status: ev.status, lagMs: Date.now() - Date.parse(ev.received_at) });
    };
    return () => source.close();
  }, [nowIso]);

  // AG Studio 3.0.0 does not redraw its grid when `data` changes (tested: new `data` prop,
  // api.setProperty("data"), and an async source with api.reload()). Until that is fixed we
  // remount Studio on each change, carrying the user's dashboard state across. The remount
  // visibly blanks the grid ("Loading…") for a moment; see the plan's spike 2 notes.
  const data = useMemo(() => ({ sources: [{ id: "invoices", name: "Invoices", data: rows, fields: SOURCE_FIELDS }] }), [rows]);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-3 text-sm">
        <span className="font-semibold">CollectPilot</span>
        <span className="flex items-center gap-4 text-zinc-500">
          {lastUpdate && (
            <span data-testid="last-update">
              {lastUpdate.invoice} → {lastUpdate.status} ({lastUpdate.lagMs} ms after webhook)
            </span>
          )}
          <span className={connected ? "text-emerald-600" : "text-zinc-400"}>{connected ? "● Live" : "○ Offline"}</span>
        </span>
      </header>
      <div className="min-h-0 flex-1">
        <AgStudio
          key={version}
          data={data}
          initialState={studioState}
          mode="view"
          onStateUpdated={(e) => (stateRef.current = e.state)}
        />
      </div>
    </div>
  );
}
