import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { OwnerHeader } from "@/components/OwnerHeader";
import { PRO, PRO_FEATURES, proState } from "@/lib/proPlan.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { isOwner } from "@/lib/server/owner";
import { cancelProAction } from "./actions";

export const metadata: Metadata = { title: "Plan · CollectPilot" };

const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: PRO.currency }).format(n);
const day = (d: string) => new Date(d).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
const FREE = [
  "Invoices from voice or text, sent by PayPal",
  "AI reminders you approve one by one",
  "Clients' AI assistants can pay your invoices",
  "Live receivables dashboard",
];

export default async function BillingPage({ searchParams }: PageProps<"/billing">) {
  await connection();
  if (!(await isOwner())) redirect("/login");
  const { cancelled, problem, upgraded } = await searchParams;
  const state = await proState(pgStore());
  const pro = state.status === "active";
  // PayPal is the source of truth for the next charge; the page still works if it is slow.
  const sub =
    state.subscriptionId && ["active", "suspended"].includes(state.status)
      ? await paypal()
          .request("GET", `/v1/billing/subscriptions/${encodeURIComponent(state.subscriptionId)}`)
          .catch(() => null)
      : null;
  const next = sub?.billing_info?.next_billing_time;

  return (
    <div className="min-h-full bg-paper">
      <OwnerHeader current="/billing" />
      <main className="mx-auto grid max-w-3xl gap-8 px-5 pb-16">
        <section className="grid gap-2 pt-2">
          <h1 className="font-display text-4xl font-semibold tracking-tight">Your plan</h1>
          <p className="text-muted">CollectPilot bills its own plan with PayPal Subscriptions, the same way your retainers are billed.</p>
        </section>

        {upgraded === "1" && pro && (
          <p className="rounded-lg border border-cleared/30 bg-cleared-soft px-4 py-3 text-sm text-cleared">You&apos;re on Pro. PayPal emailed you the receipt.</p>
        )}
        {upgraded === "1" && !pro && (
          <p className="rounded-lg border border-line bg-card px-4 py-3 text-sm text-muted">PayPal is finishing your upgrade. Refresh in a minute.</p>
        )}
        {cancelled === "1" && <p className="rounded-lg border border-line bg-card px-4 py-3 text-sm text-muted">You left PayPal without upgrading. Nothing was charged.</p>}
        {problem === "1" && (
          <p role="alert" className="rounded-lg border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
            PayPal couldn&apos;t finish that just now. Nothing was charged. Please try again in a minute.
          </p>
        )}
        {state.status === "suspended" && (
          <p role="alert" className="rounded-lg border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
            PayPal couldn&apos;t collect your last payment, so Pro is paused. Update your payment method in PayPal to resume.
          </p>
        )}

        <section className="grid gap-4 sm:grid-cols-2">
          <article className={`grid content-start gap-4 rounded-xl border bg-card p-6 ${pro ? "border-line" : "border-ink"}`}>
            <header className="flex items-baseline justify-between gap-2">
              <h2 className="font-display text-2xl font-semibold tracking-tight">Free</h2>
              {!pro && <span className="rounded-full bg-line px-2.5 py-0.5 text-xs font-semibold text-muted">Current</span>}
            </header>
            <p className="font-display text-3xl font-semibold tabular-nums">{money(0)}</p>
            <ul className="grid gap-2 text-sm leading-relaxed">
              {FREE.map((f) => (
                <li key={f} className="flex gap-2">
                  <span aria-hidden className="mt-0.5 text-cleared">✓</span>
                  {f}
                </li>
              ))}
            </ul>
          </article>

          <article className={`grid content-start gap-4 rounded-xl border-2 bg-card p-6 ${pro ? "border-cleared" : "border-ink"}`}>
            <header className="flex items-baseline justify-between gap-2">
              <h2 className="font-display text-2xl font-semibold tracking-tight">Pro</h2>
              {pro && <span className="rounded-full bg-cleared-soft px-2.5 py-0.5 text-xs font-semibold text-cleared">Current</span>}
            </header>
            <p className="font-display text-3xl font-semibold tabular-nums">
              {money(PRO.amount)}
              <span className="text-base font-medium text-muted">/month</span>
            </p>
            <ul className="grid gap-2 text-sm leading-relaxed">
              <li className="text-muted">Everything in Free, plus:</li>
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex gap-2">
                  <span aria-hidden className="mt-0.5 text-cleared">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            {pro ? (
              <div className="grid gap-3 border-t border-line pt-4 text-sm">
                <p className="text-muted">
                  {next ? `Next charge ${money(PRO.amount)} on ${day(next)}.` : "Billed monthly by PayPal."}
                  {state.paymentsCount > 0 && ` ${state.paymentsCount} payment${state.paymentsCount === 1 ? "" : "s"} so far.`}
                </p>
                <form action={cancelProAction}>
                  <button className="font-semibold text-pending hover:underline">Cancel Pro (PayPal stops billing)</button>
                </form>
              </div>
            ) : (
              <form action="/billing/start" method="post" className="grid gap-2">
                <button className="rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-white hover:bg-ink/90">
                  Upgrade with PayPal · {money(PRO.amount)}/month
                </button>
                <p className="text-center text-xs text-muted">Cancel any time. PayPal emails a receipt every month.</p>
              </form>
            )}
          </article>
        </section>
      </main>
    </div>
  );
}
