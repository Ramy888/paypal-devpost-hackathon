import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { CopyField } from "@/components/connect/CopyField";
import { OwnerHeader } from "@/components/OwnerHeader";
import { LiveRefresh } from "@/components/LiveRefresh";
import { findRetainerCandidates } from "@/lib/retainers.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { listInvoices } from "@/lib/server/paypal";
import { isOwner } from "@/lib/server/owner";
import { ownerIsPro } from "@/lib/server/pro";
import Link from "next/link";
import { createRetainerOffer, endRetainerAction } from "./actions";

export const metadata: Metadata = { title: "Retainers · CollectPilot" };
// A client approving an offer (or PayPal activating/billing it) refreshes this page.
const RETAINER_EVENTS = ["APP.RETAINER"];

type Retainer = {
  id: string;
  publicId: string;
  clientEmail: string;
  clientName: string;
  amount: number;
  currency: string;
  description: string;
  status: "offered" | "pending" | "active" | "suspended" | "cancelled";
  paymentsCount: number;
  paidTotal: number;
  lastPaymentAt: string | Date | null;
};
type Candidate = {
  clientEmail: string;
  clientName: string;
  currency: string;
  paidCount: number;
  paidTotal: number;
  suggestedAmount: number;
};

const money = (n: number, c: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
const STATUS: Record<Retainer["status"], { label: string; tone: string }> = {
  offered: { label: "Offer open", tone: "bg-pending-soft text-pending" },
  pending: { label: "Client is approving", tone: "bg-pending-soft text-pending" },
  active: { label: "Active", tone: "bg-cleared-soft text-cleared" },
  suspended: { label: "Payment failed", tone: "bg-ink text-white" },
  cancelled: { label: "Ended", tone: "bg-line text-muted" },
};
const field = "w-full min-w-0 rounded-md border border-line bg-paper px-3 py-2 text-ink";

function offerEmail(r: Retainer, link: string, freelancer: string) {
  const subject = `A monthly retainer from ${freelancer}`;
  const body =
    `Hi${r.clientName ? ` ${r.clientName}` : ""},\n\nThanks for the steady work together. Instead of a new invoice each time, ` +
    `I can offer a monthly retainer: ${money(r.amount, r.currency)} a month for ${r.description}.\n\n` +
    `You approve it once with PayPal and can cancel any time:\n${link}\n\n${freelancer}`;
  return `mailto:${encodeURIComponent(r.clientEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default async function RetainersPage({ searchParams }: PageProps<"/retainers">) {
  await connection();
  if (!(await isOwner())) redirect("/login");
  const { error, created } = await searchParams;
  const freelancer = process.env.FREELANCER_NAME ?? "Your studio";
  const store = pgStore();
  const [retainers, list, pro]: [Retainer[], { items?: unknown[] }, boolean] = await Promise.all([
    store.listRetainers(),
    listInvoices("page_size=100"),
    ownerIsPro(),
  ]);
  const candidates: Candidate[] = findRetainerCandidates({ invoices: list.items ?? [], existing: retainers });

  return (
    <div className="min-h-full bg-paper">
      <OwnerHeader current="/retainers" />
      <LiveRefresh prefixes={RETAINER_EVENTS} />
      <main className="mx-auto grid w-full max-w-3xl gap-8 px-4 pb-16 sm:px-5">
        <section className="grid gap-2 pt-2">
          <h1 className="font-display text-4xl font-semibold tracking-tight">Retainers</h1>
          <p className="text-muted">
            Clients who keep paying you can switch to a monthly retainer. They approve it once with PayPal, and PayPal bills them every
            month until either of you cancels.
          </p>
        </section>

        {typeof error === "string" && (
          <p role="alert" className="rounded-lg border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
            {error}
          </p>
        )}

        <section className="grid gap-4">
          <h2 className="font-display text-2xl font-semibold tracking-tight">Ready for a retainer ({candidates.length})</h2>
          {candidates.length === 0 ? (
            <p className="text-muted">No one yet. A client shows up here after paying you twice.</p>
          ) : (
            candidates.map((c) => (
              <form key={c.clientEmail} action={createRetainerOffer} className="grid gap-4 rounded-xl border border-line bg-card p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate font-medium">{c.clientName || c.clientEmail}</p>
                  <p className="text-sm text-muted">
                    Paid {c.paidCount} invoices · {money(c.paidTotal, c.currency)}
                  </p>
                </div>
                <input type="hidden" name="clientEmail" value={c.clientEmail} />
                <input type="hidden" name="clientName" value={c.clientName} />
                <input type="hidden" name="currency" value={c.currency} />
                <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                  <label className="grid gap-1.5 text-sm">
                    <span className="text-muted">Per month ({c.currency})</span>
                    <input name="amount" type="number" min={1} max={10000} step="0.01" defaultValue={c.suggestedAmount} className={`${field} tabular-nums`} />
                  </label>
                  <label className="grid gap-1.5 text-sm">
                    <span className="text-muted">What it covers</span>
                    <input name="description" dir="auto" maxLength={120} defaultValue="Monthly video editing" className={field} />
                  </label>
                </div>
                <p className="text-xs text-muted">Suggested from the typical invoice they paid. Nothing is charged until the client approves.</p>
                {pro ? (
                  <button className="w-fit rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white">Create retainer offer</button>
                ) : (
                  <p className="text-sm">
                    Retainers are part of Pro.{" "}
                    <Link href="/billing" className="font-semibold text-cleared hover:underline">
                      Upgrade for $12/month →
                    </Link>
                  </p>
                )}
              </form>
            ))
          )}
        </section>

        {retainers.length > 0 && (
          <section className="grid gap-4">
            <h2 className="font-display text-2xl font-semibold tracking-tight">Offers and retainers</h2>
            {retainers.map((r) => {
              const link = `${process.env.APP_URL}/retainer/${r.publicId}`;
              const open = r.status === "offered" || r.status === "pending";
              return (
                <article key={r.id} className={`grid gap-4 rounded-xl border bg-card p-5 ${created === r.publicId ? "border-ink" : "border-line"}`}>
                  <header className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="min-w-0 truncate font-medium">{r.clientName || r.clientEmail}</span>
                    <span className="text-muted">·</span>
                    <span className="tabular-nums">{money(r.amount, r.currency)}/month</span>
                    <span className={`ms-auto rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
                  </header>
                  <p className="text-sm text-muted" dir="auto">
                    {r.description}
                    {r.paymentsCount > 0 &&
                      ` · ${r.paymentsCount} monthly payment${r.paymentsCount === 1 ? "" : "s"} received (${money(r.paidTotal, r.currency)})`}
                  </p>
                  {open && (
                    <div className="grid gap-3">
                      <CopyField label="Offer link for the client" value={link} />
                      <a href={offerEmail(r, link, freelancer)} className="w-fit rounded-lg border border-line px-4 py-2.5 text-sm font-semibold">
                        Email the offer
                      </a>
                    </div>
                  )}
                  {r.status !== "cancelled" && (
                    <form action={endRetainerAction.bind(null, r.id)}>
                      <button className="text-sm font-semibold text-pending hover:underline">
                        {open ? "Withdraw offer" : "End retainer (PayPal stops billing)"}
                      </button>
                    </form>
                  )}
                </article>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}
