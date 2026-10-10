"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AgStudio } from "ag-studio-react";
import type { AgReportState } from "ag-studio";
import { applyEvent } from "@/lib/invoices.mjs";

export type InvoiceRow = {
  id: string;
  invoice_number: string;
  client: string;
  amount: number;
  amount_due: number;
  currency: string;
  status: string;
  paid: boolean;
  due_date: string;
  days_overdue: number;
  risk: string;
  expected_pay_date: string;
  project: string; // "Acme site · 2/3" for an invoice that is part of a payment schedule
  held: boolean; // the client marked this part "Not done yet"
  // Per-row amounts the cash-panel tiles sum (0 when paid or not applicable).
  outstanding: number;
  overdue_amount: number;
  expected_7d: number;
  at_risk: number;
};

type LiveEvent = { invoice_id: string; status: string; received_at: string };

const FIELDS = [
  { id: "invoice_number", name: "Invoice", format: "textFormat" },
  { id: "project", name: "Schedule", format: "textFormat" },
  { id: "client", name: "Client", format: "textFormat" },
  { id: "amount", name: "Amount", format: "currencyFormat" },
  { id: "status", name: "Status", format: "textFormat" },
  { id: "due_date", name: "Due", format: "textFormat" },
  { id: "days_overdue", name: "Days overdue", format: "integerFormat" },
  { id: "risk", name: "Risk", format: "textFormat" },
  { id: "expected_pay_date", name: "Expected pay date", format: "textFormat" },
] as const;

// The cash panel: four tiles, each the sum of one per-row amount.
const PANEL = [
  { id: "outstanding", name: "Outstanding", format: "currencyFormat" },
  { id: "overdue_amount", name: "Overdue", format: "currencyFormat" },
  { id: "expected_7d", name: "Expected in 7 days", format: "currencyFormat" },
  { id: "at_risk", name: "At risk", format: "currencyFormat" },
] as const;

// One stable array: Studio ignores field changes after the first render.
const SOURCE_FIELDS = [...FIELDS, ...PANEL];
const TILE_ROWS = 6;

const INITIAL_STATE: AgReportState = {
  selectedPageId: "receivables",
  pages: [
    {
      id: "receivables",
      widgets: {
        ...Object.fromEntries(
          PANEL.map((f) => [
            f.id,
            {
              type: "value",
              dataMapping: { value: [{ id: `invoices.${f.id}`, aggregation: "sum" }] },
              format: { title: { enabled: true, text: f.name } },
            },
          ]),
        ),
        invoices: {
          type: "grid",
          dataMapping: { cols: FIELDS.map((f) => ({ id: `invoices.${f.id}` })) },
          format: { title: { enabled: true, text: "Receivables" } },
        },
      },
      widgetLayout: {
        ...Object.fromEntries(PANEL.map((f, i) => [f.id, { xTrack: i * 6, yTrack: 0, xSpan: 6, ySpan: TILE_ROWS }])),
        invoices: { xTrack: 0, yTrack: TILE_ROWS, xSpan: 24, ySpan: 30 },
      },
    },
  ],
};

// AG Studio's layout canvas needs ~720px, so phones get a plain list of the same rows.
const NARROW = "(max-width: 639px)";
const subscribeNarrow = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const money = (n: number, c: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);

// Phones get the same four numbers as plain tiles. Assumes one currency, like the Studio tiles.
function PhoneCashPanel({ rows }: { rows: InvoiceRow[] }) {
  const currency = rows[0]?.currency ?? "USD";
  return (
    <dl className="grid grid-cols-2 gap-px border-b border-zinc-200 bg-zinc-200">
      {PANEL.map((f) => (
        <div key={f.id} className="bg-white px-4 py-3">
          <dt className="text-xs text-zinc-500">{f.name}</dt>
          <dd className="font-semibold tabular-nums">{money(rows.reduce((sum, r) => sum + r[f.id], 0), currency)}</dd>
        </div>
      ))}
    </dl>
  );
}

function PhoneList({ rows }: { rows: InvoiceRow[] }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-zinc-500">No invoices yet.</p>;
  return (
    <>
    <PhoneCashPanel rows={rows} />
    <ul className="divide-y divide-zinc-200">
      {rows.map((r) => (
        <li key={r.id} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-4 py-3 text-sm">
          <span className="truncate font-medium">{r.client}</span>
          <span className="text-right font-semibold tabular-nums">{money(r.amount, r.currency)}</span>
          <span className="truncate font-mono text-xs text-zinc-500">
            {r.project ? `${r.project} · ` : ""}
            {r.invoice_number} · due {r.due_date}
            {r.expected_pay_date && ` · expect ${r.expected_pay_date}`}
          </span>
          <span className={`text-right text-xs font-semibold ${r.paid ? "text-emerald-700" : r.days_overdue > 0 ? "text-amber-700" : "text-zinc-500"}`}>
            {r.paid ? "Paid" : r.held ? "On hold" : r.days_overdue > 0 ? `${r.days_overdue}d overdue` : r.status.toLowerCase()}
          </span>
        </li>
      ))}
    </ul>
    </>
  );
}

// nowIso is the server's demo-clock "today", so days overdue match what the agent sees.
export default function ReceivablesDashboard({ initialRows, nowIso }: { initialRows: InvoiceRow[]; nowIso: string }) {
  const [rows, setRows] = useState(initialRows);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const [studioState, setStudioState] = useState<AgReportState>(INITIAL_STATE);
  const stateRef = useRef<AgReportState>(INITIAL_STATE);
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
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
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-200 px-4 py-3 text-sm sm:px-6">
        <span className="font-semibold">CollectPilot</span>
        <nav className="flex gap-4 font-medium text-emerald-700">
          <Link href="/invoices/new">New invoice</Link>
          <Link href="/reminders">Reminders</Link>
          <Link href="/schedules">Schedules</Link>
          <Link href="/retainers">Retainers</Link>
          <Link href="/digest">Digest</Link>
        </nav>
        <span className="ms-auto flex min-w-0 items-center gap-4 text-zinc-500">
          {lastUpdate && (
            <span data-testid="last-update" className="hidden truncate sm:inline">
              {lastUpdate.invoice} → {lastUpdate.status} ({lastUpdate.lagMs} ms after webhook)
            </span>
          )}
          <span className={connected ? "text-emerald-600" : "text-zinc-400"}>{connected ? "● Live" : "○ Offline"}</span>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {narrow ? (
          <PhoneList rows={rows} />
        ) : (
          <AgStudio
            key={version}
            data={data}
            initialState={studioState}
            mode="view"
            onStateUpdated={(e) => (stateRef.current = e.state)}
          />
        )}
      </div>
    </div>
  );
}
