import type { Metadata } from "next";
import { connection } from "next/server";
import { StepBar } from "@/components/StepBar";
import { CONNECT_STEPS } from "@/components/journeys";
import { SPEND_LIMITS } from "@/lib/connect.mjs";
import { paypal } from "@/lib/server/paypal";

export const metadata: Metadata = { title: "Connect your AI agent · CollectPilot" };

type InvoiceContext = { id: string; number: string; amount: string; currency: string; dueDate: string | null; from: string | null; paid: boolean };

// Context shown when the client arrives from an invoice link (/connect?invoice=INV2-...).
// Invoices link here by number (/connect?n=RVS-...); older links use the PayPal id (?invoice=INV2-...).
async function findInvoice(invoiceId?: string, number?: string) {
  if (invoiceId && /^INV2-[A-Z0-9-]+$/.test(invoiceId)) return paypal().request("GET", `/v2/invoicing/invoices/${invoiceId}`);
  if (number && /^[A-Z0-9-]{3,40}$/.test(number)) {
    const res = await paypal().request("POST", "/v2/invoicing/search-invoices?page=1&page_size=1", { invoice_number: number });
    const id = res.items?.[0]?.id;
    return id ? paypal().request("GET", `/v2/invoicing/invoices/${id}`) : null;
  }
  return null;
}

async function invoiceContext(invoiceId: string | undefined, number?: string): Promise<InvoiceContext | null> {
  try {
    const inv = await findInvoice(invoiceId, number);
    if (!inv) return null;
    const paid = ["PAID", "MARKED_AS_PAID"].includes(inv.status);
    const shown = paid ? inv.amount : (inv.due_amount ?? inv.amount);
    return {
      id: inv.id,
      number: inv.detail?.invoice_number ?? inv.id,
      amount: shown?.value,
      currency: shown?.currency_code,
      dueDate: inv.detail?.payment_term?.due_date ?? null,
      from: inv.invoicer?.business_name ?? null,
      paid,
    };
  } catch {
    return null;
  }
}

const money = (value: string, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value));

const CAN = [
  "See the CollectPilot invoices addressed to your PayPal account",
  "Pay one of those invoices in full, up to the limit you set below",
];
const CANNOT = [
  "See your PayPal balance, cards or other payments",
  "Pay anyone else, or pay more than your limit",
  "Keep access after you revoke it",
];

export default async function ConnectPage({ searchParams }: PageProps<"/connect">) {
  await connection();
  const { invoice, n } = await searchParams;
  const ctx = await invoiceContext(typeof invoice === "string" ? invoice : undefined, typeof n === "string" ? n : undefined);

  return (
    <div className="grid gap-8">
      <StepBar label="Connect your AI agent" steps={CONNECT_STEPS.map((title, i) => ({ title, state: i === 0 ? "active" : "todo" }))} />
      <section className="grid gap-3 pt-4">
        <p className="text-sm font-medium text-cleared">For the client paying the invoice</p>
        <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl">
          Let your AI agent pay {ctx?.from ? `${ctx.from}'s` : "your freelancer's"} invoices on time
        </h1>
        <p className="max-w-[60ch] text-lg leading-relaxed text-muted">
          Approve once with PayPal. After that, your accounts-payable assistant can settle invoices when they are due, within a
          limit you choose, and PayPal emails you a receipt every time.
        </p>
      </section>

      {ctx && (
        <section aria-label="Invoice" className="grid gap-4 rounded-xl border border-line bg-card p-5 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Invoice{ctx.from ? ` from ${ctx.from}` : ""}</p>
            <p className="mt-1 font-mono text-sm text-ink">{ctx.number}</p>
            {ctx.dueDate && <p className="mt-1 text-sm text-muted">Due {new Date(`${ctx.dueDate}T00:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}</p>}
          </div>
          <div className="flex items-center gap-3 sm:justify-end">
            {ctx.paid && <span className="rounded-full bg-cleared-soft px-2.5 py-1 text-xs font-semibold text-cleared">Paid</span>}
            <p className="font-display text-3xl font-semibold tabular-nums">{money(ctx.amount, ctx.currency)}</p>
          </div>
        </section>
      )}

      <section className="grid gap-6 rounded-xl border border-line bg-card p-6 sm:grid-cols-2">
        <div className="grid content-start gap-3">
          <h2 className="font-medium">Your agent can</h2>
          <ul className="grid gap-2 text-sm leading-relaxed">
            {CAN.map((t) => (
              <li key={t} className="flex gap-2">
                <span aria-hidden className="mt-0.5 text-cleared">✓</span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="grid content-start gap-3">
          <h2 className="font-medium">Your agent cannot</h2>
          <ul className="grid gap-2 text-sm leading-relaxed text-muted">
            {CANNOT.map((t) => (
              <li key={t} className="flex gap-2">
                <span aria-hidden className="mt-0.5">✕</span>
                {t}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <form action="/connect/start" method="post" className="grid gap-6 rounded-xl border border-line bg-card p-6">
        <input type="hidden" name="invoice" value={ctx?.id ?? ""} />
        <fieldset className="grid gap-3">
          <legend className="font-medium">Most your agent may pay per invoice</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {SPEND_LIMITS.map((limit, i) => (
              <label
                key={limit}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-line px-4 py-3 has-[:checked]:border-cleared has-[:checked]:bg-cleared-soft"
              >
                <span className="font-display text-xl font-semibold tabular-nums">{money(String(limit), "USD")}</span>
                <input type="radio" name="limit" value={limit} defaultChecked={i === 1} className="accent-[var(--cleared)]" />
              </label>
            ))}
          </div>
          <p className="text-sm text-muted">Anything above the limit is left for you to pay yourself.</p>
        </fieldset>

        <div className="grid gap-3">
          <button type="submit" className="rounded-lg bg-ink px-5 py-3.5 text-base font-semibold text-white hover:bg-ink/90">
            Continue to PayPal
          </button>
          <p className="text-center text-sm text-muted">No money moves now. You can revoke access at any time.</p>
        </div>
      </form>
    </div>
  );
}
