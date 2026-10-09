import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { OwnerHeader } from "@/components/OwnerHeader";
import { buildDigest } from "@/lib/digest.mjs";
import { PRO } from "@/lib/proPlan.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { recentWindow } from "@/lib/server/clock.mjs";
import { isOwner } from "@/lib/server/owner";

export const metadata: Metadata = { title: "Digest · CollectPilot" };

const DETAIL_CONCURRENCY = 5;

type Item = { invoiceNumber?: string; client: string; amount: number; currency: string; date?: string; evidence?: string };

const money = (n: number, c = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });

// The list endpoint has no payment transactions, so fetch details for invoices that received
// money, a few at a time. Failures are counted so the page can say the totals may be low.
async function invoicesWithPayments() {
  const list = await paypal().request("GET", "/v2/invoicing/invoices?page_size=100&total_required=true");
  const items: { id: string; payments?: { paid_amount?: { value: string } } }[] = list.items ?? [];
  const out: { id: string }[] = [];
  let failed = 0;
  for (let i = 0; i < items.length; i += DETAIL_CONCURRENCY) {
    const batch = items.slice(i, i + DETAIL_CONCURRENCY);
    out.push(
      ...(await Promise.all(
        batch.map((inv) =>
          Number(inv.payments?.paid_amount?.value ?? 0) > 0
            ? paypal()
                .request("GET", `/v2/invoicing/invoices/${encodeURIComponent(inv.id)}`)
                .catch(() => {
                  failed++;
                  return inv;
                })
            : inv,
        ),
      )),
    );
  }
  return { invoices: out, failed, more: Number(list.total_items ?? items.length) > items.length };
}

function Section({ title, total, note, items, currency }: { title: string; total: number; note: string; items: Item[]; currency: string }) {
  return (
    <section className="grid gap-3 rounded-xl border border-line bg-card p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold tracking-tight">{title}</h2>
        <span className="font-display text-2xl font-semibold tabular-nums">{money(total, currency)}</span>
      </header>
      <p className="text-sm text-muted">{note}</p>
      {items.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {items.map((i, n) => (
            <li key={n} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 py-2">
              <span className="truncate">
                {i.invoiceNumber && <span className="font-mono">{i.invoiceNumber} · </span>}
                {i.client}
              </span>
              <span className="text-right font-semibold tabular-nums">{money(i.amount, i.currency)}</span>
              <span className="col-span-2 truncate text-xs text-muted">
                {i.date && `${day(i.date)} · `}
                {i.evidence}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function DigestPage() {
  await connection();
  if (!(await isOwner())) redirect("/login");
  const { from, to } = await recentWindow(7);
  const [{ invoices, failed, more }, retainers] = await Promise.all([invoicesWithPayments(), pgStore().listRetainers()]);
  const reminders = await pgStore().listSentReminders(invoices.map((i) => i.id));
  const d = buildDigest({ invoices, reminders, retainers, from, to, planPrice: PRO.amount });
  const collected = d.byAgent.total + d.afterReminder.total;

  return (
    <div className="min-h-full bg-paper">
      <OwnerHeader current="/digest" />
      <main className="mx-auto grid max-w-3xl gap-6 px-5 pb-16">
        <section className="grid gap-2 pt-2">
          <p className="text-sm text-muted">
            {day(d.from)} to {day(d.to)}
          </p>
          <h1 className="font-display text-4xl font-semibold tracking-tight">
            Collected {money(collected, d.currency)} while you were away
          </h1>
          <p className="text-muted">
            {money(d.recurring.monthly, d.currency)}/mo recurring created · your plan: {money(d.planPrice, PRO.currency)}
            {d.multiple > 0 && (
              <>
                {" · "}
                <strong className="text-cleared">{d.multiple}× what CollectPilot costs you</strong>
              </>
            )}
          </p>
        </section>

        {(failed > 0 || more) && (
          <p role="alert" className="rounded-lg border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
            {failed > 0 ? `PayPal didn't return ${failed} invoice${failed === 1 ? "" : "s"}, so these totals may be low. Refresh in a minute.` : "Only your latest 100 invoices are counted."}
          </p>
        )}
        <Section
          title="Paid by clients' AI agents"
          total={d.byAgent.total}
          note="Each line is a PayPal capture made through your agent-payable invoices."
          items={d.byAgent.items}
          currency={d.currency}
        />
        <Section
          title="Paid after a reminder"
          total={d.afterReminder.total}
          note="Paid on or after the day CollectPilot sent a reminder for that invoice."
          items={d.afterReminder.items}
          currency={d.currency}
        />
        <Section
          title="Recurring revenue"
          total={d.recurring.monthly}
          note="Active retainers, billed monthly by PayPal Subscriptions."
          items={d.recurring.items}
          currency={d.currency}
        />
        <Section
          title="At risk"
          total={d.atRisk.total}
          note="Unpaid and high risk. Not counted above; worth a call."
          items={d.atRisk.items}
          currency={d.currency}
        />
        {d.other.total > 0 && (
          <p className="text-sm text-muted">
            Clients also paid {money(d.other.total, d.currency)} on their own in this period. CollectPilot doesn&apos;t take credit for that.
          </p>
        )}
      </main>
    </div>
  );
}
