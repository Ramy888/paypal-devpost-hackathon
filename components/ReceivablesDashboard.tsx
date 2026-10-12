"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AgStudio } from "ag-studio-react";
import { studioTheme, createAiHarness, AgStudioModuleRegistry, AgStudioAiModule } from "ag-studio";
import { claudeAdapter, pageHistory } from "@/components/studioAdapter";
import { OwnerHeader } from "@/components/OwnerHeader";
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
  { id: "client", name: "Client", format: "textFormat" },
  { id: "amount", name: "Amount", format: "currencyFormat" },
  { id: "status_label", name: "Status", format: "textFormat" },
  { id: "due_date", name: "Due", format: "textFormat" },
  { id: "risk", name: "Risk", format: "textFormat" },
  { id: "expected_pay_date", name: "Expected", format: "textFormat" },
] as const;

// The cash panel: four tiles, each the sum of one per-row amount.
const PANEL = [
  { id: "outstanding", name: "Outstanding", format: "currencyFormat" },
  { id: "overdue_amount", name: "Overdue", format: "currencyFormat" },
  { id: "expected_7d", name: "Next 7 days", format: "currencyFormat" },
  { id: "at_risk", name: "At risk", format: "currencyFormat" },
] as const;

// PayPal's status codes, as people say them.
const STATUS_LABEL: Record<string, string> = { SENT: "Sent", UNPAID: "Unpaid", PARTIALLY_PAID: "Part paid", PAID: "Paid", MARKED_AS_PAID: "Paid", DRAFT: "Draft", SCHEDULED: "Scheduled", CANCELLED: "Cancelled", REFUNDED: "Refunded", PARTIALLY_REFUNDED: "Part refunded", PAYMENT_PENDING: "Pending" };
const statusLabel = (r: InvoiceRow) => (r.held ? "On hold" : STATUS_LABEL[r.status] ?? r.status);

// Days overdue stays a data field (the phone list uses it) but not a grid column: Status and Risk say it.
// Schedule labels show in the phone list and on /schedules; the grid has no room for them.
const HIDDEN = [
  { id: "days_overdue", name: "Days overdue", format: "integerFormat" },
  { id: "project", name: "Schedule", format: "textFormat" },
] as const;

// Studio in the app's own look: paper canvas, white cards, ink text, the "cleared" green accent.
const THEME = studioTheme.withParams({
  accentColor: "#0d6b57",
  backgroundColor: "#ffffff",
  foregroundColor: "#12202b",
  borderColor: "#e1e0d9",
  fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  studioCanvasFontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  studioMinWidth: 600,
  studioWrapperBorder: "none",
  studioWrapperBackgroundColor: "#f4f3ef",
  studioWrapperSpacing: 0,
  studioCanvasBackgroundColor: "#f4f3ef",
  studioCanvasBorder: "none",
  studioCanvasShadow: "none",
  studioCanvasPadding: 0,
  studioWidgetBorder: "1px solid #e1e0d9",
  studioWidgetBorderRadius: 12,
  studioWidgetBackgroundColor: "#ffffff",
  studioWidgetTitleFontFamily: "var(--font-bricolage), ui-sans-serif, system-ui, sans-serif",
  studioWidgetTitleTextColor: "#5d6a72",
} as Parameters<typeof studioTheme.withParams>[0]);
// Only the "Ask AI" panel: AG Studio offers it in edit mode, so the page runs in edit mode with the
// editing and data panels left out. Studio's own agents answer, on Claude (components/studioAdapter).
const PANELS = { edit: { right: ["ai" as const] } };
AgStudioModuleRegistry.registerModules([AgStudioAiModule]);
const AI = ({ api }: { api: Parameters<typeof createAiHarness>[0] }) =>
  createAiHarness(api, {
    adapter: claudeAdapter,
    history: pageHistory,
    promptStarters: [
      { label: "Which clients are at risk?", prompt: "Which clients are at risk of paying late, and how much do they owe? Answer from the invoices data." },
      { label: "What's overdue?", prompt: "List the overdue invoices with client, amount and days overdue." },
      { label: "Chart overdue by client", prompt: "Add a bar chart of the overdue amount by client to this page." },
    ],
  });

// One stable array: Studio ignores field changes after the first render.
// Amounts show with their currency sign (the receivables are in one currency, as in the tiles).
const CURRENCY_FORMAT = { format: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }) };
const withCurrency = <T extends { format: string }>(f: T) => (f.format === "currencyFormat" ? { ...f, formatOptions: CURRENCY_FORMAT } : f);
const SOURCE_FIELDS = [...FIELDS, ...PANEL, ...HIDDEN].map(withCurrency);
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
          format: { title: { enabled: true, text: "Invoices" }, style: { columnAutoSize: false, columnWidth: 100 } },
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
      if (!ev.invoice_id) return; // e.g. a retainer change: nothing to redraw here
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
  const data = useMemo(
    () => ({ sources: [{ id: "invoices", name: "Invoices", data: rows.map((r) => ({ ...r, status_label: statusLabel(r) })), fields: SOURCE_FIELDS }] }),
    [rows],
  );

  return (
    <div className="min-h-full bg-paper">
      <OwnerHeader current="/" wide />
      <main className="mx-auto grid max-w-6xl gap-5 px-5 pb-16">
        <section className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 pt-2">
          <div className="grid gap-2">
            <h1 className="font-display text-4xl font-semibold tracking-tight">Receivables</h1>
            <p className="text-muted">Every PayPal invoice you sent, updated the moment PayPal tells us it moved.</p>
          </div>
          <p className="flex items-center gap-2 text-sm">
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-cleared" : "bg-line"}`} aria-hidden />
            <span className={connected ? "font-semibold text-cleared" : "text-muted"}>{connected ? "Live" : "Offline"}</span>
          </p>
        </section>
        {lastUpdate && (
          <p data-testid="last-update" className="truncate rounded-lg border border-cleared/30 bg-cleared-soft px-4 py-2 text-sm text-cleared">
            {lastUpdate.invoice} is now {lastUpdate.status.toLowerCase().replaceAll("_", " ")} · {lastUpdate.lagMs} ms after PayPal&apos;s webhook
          </p>
        )}
        {narrow ? (
          <div className="overflow-hidden rounded-xl border border-line bg-card">
            <PhoneList rows={rows} />
          </div>
        ) : (
          <div className="h-[calc(100dvh-13rem)] min-h-[34rem]">
            <AgStudio
              key={version}
              data={data}
              initialState={studioState}
              mode="edit"
              theme={THEME}
              panels={PANELS}
              ai={AI}
              onStateUpdated={(e) => (stateRef.current = e.state)}
            />
          </div>
        )}
      </main>
    </div>
  );
}
