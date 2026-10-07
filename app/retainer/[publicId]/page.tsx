import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { Steps } from "@/components/connect/Steps";
import { Notice } from "@/components/connect/Notice";
import { pgStore } from "@/lib/server/db.mjs";

export const metadata: Metadata = { title: "Monthly retainer offer · CollectPilot", robots: { index: false } };

const money = (n: number, c: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);

export default async function RetainerOfferPage({ params, searchParams }: PageProps<"/retainer/[publicId]">) {
  await connection();
  const { publicId } = await params;
  const { cancelled, problem } = await searchParams;
  const r = /^[A-Za-z0-9_-]{22}$/.test(publicId) ? await pgStore().findRetainerByPublicId(publicId) : null;
  if (!r) notFound();
  if (r.status === "active" || r.status === "suspended") redirect(`/retainer/${publicId}/done`);
  const freelancer = process.env.FREELANCER_NAME ?? "Your freelancer";

  if (r.status === "cancelled") {
    return (
      <Notice
        title="This offer is no longer open"
        body={`${freelancer} withdrew this retainer offer, so there is nothing to approve. Ask them for a new link if you still want one.`}
      />
    );
  }

  return (
    <div className="grid gap-8">
      <section className="grid gap-3 pt-4">
        <p className="text-sm font-medium text-cleared">An offer from {freelancer}</p>
        <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl">
          One monthly retainer instead of an invoice every time
        </h1>
        <p className="max-w-[60ch] text-lg leading-relaxed text-muted">
          You have paid {freelancer} more than once. Approve this retainer once with PayPal and you are billed the same amount each
          month, with a PayPal receipt every time.
        </p>
      </section>

      {cancelled === "1" && (
        <p className="rounded-lg border border-line bg-card px-4 py-3 text-sm text-muted">
          You left PayPal without approving, so nothing was set up or charged. You can try again below.
        </p>
      )}
      {problem === "1" && (
        <p role="alert" className="rounded-lg border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
          PayPal couldn&apos;t start the approval just now. Nothing was charged. Please try again in a minute.
        </p>
      )}

      <section aria-label="Retainer" className="grid gap-4 rounded-xl border border-line bg-card p-5 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Monthly retainer{r.clientName ? ` for ${r.clientName}` : ""}</p>
          <p className="mt-1 text-ink" dir="auto">
            {r.description}
          </p>
          <p className="mt-1 text-sm text-muted">Billed monthly by PayPal · cancel any time</p>
        </div>
        <p className="font-display text-3xl font-semibold tabular-nums">
          {money(r.amount, r.currency)}
          <span className="text-base font-medium text-muted">/month</span>
        </p>
      </section>

      <form action="/retainer/start" method="post" className="grid gap-3 rounded-xl border border-line bg-card p-6">
        <input type="hidden" name="r" value={publicId} />
        <button type="submit" className="rounded-lg bg-ink px-5 py-3.5 text-base font-semibold text-white hover:bg-ink/90">
          Approve with PayPal
        </button>
        <p className="text-center text-sm text-muted">The first month is charged when you approve. Nothing is charged if you go back.</p>
      </form>

      <section className="grid gap-4">
        <h2 className="font-display text-2xl font-semibold tracking-tight">What happens next</h2>
        <Steps
          items={[
            { title: "Approve on PayPal", body: `PayPal shows the amount and asks you to confirm the monthly retainer with ${freelancer}.` },
            { title: "First month is paid", body: "PayPal charges the first month right away and emails you a receipt." },
            { title: "Then once a month", body: "PayPal bills the same amount each month. Cancel any time from your PayPal account or by asking the freelancer." },
          ]}
        />
      </section>
    </div>
  );
}
