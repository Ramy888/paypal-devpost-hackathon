import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { StepBar } from "@/components/StepBar";
import { RETAINER_STEPS } from "@/components/journeys";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";

export const metadata: Metadata = { title: "Retainer approved · CollectPilot", robots: { index: false } };

const money = (n: number, c: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
const day = (d: string | Date) => new Date(d).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });

export default async function RetainerDonePage({ params }: PageProps<"/retainer/[publicId]/done">) {
  await connection();
  const { publicId } = await params;
  const r = /^[A-Za-z0-9_-]{22}$/.test(publicId) ? await pgStore().findRetainerByPublicId(publicId) : null;
  if (!r) notFound();
  if (r.status === "offered" || r.status === "cancelled" || !r.subscriptionId) redirect(`/retainer/${publicId}`);
  const freelancer = process.env.FREELANCER_NAME ?? "Your freelancer";

  // PayPal is the source of truth for billing dates; fall back quietly if it is slow.
  const sub = await paypal()
    .request("GET", `/v1/billing/subscriptions/${encodeURIComponent(r.subscriptionId)}`)
    .catch(() => null);
  const lastPaid = sub?.billing_info?.last_payment?.time ?? r.lastPaymentAt;
  const next = sub?.billing_info?.next_billing_time;
  const firstPaid = Boolean(lastPaid) || r.paymentsCount > 0;
  const steps = RETAINER_STEPS.map((title, i) => ({
    title,
    state: i < 2 ? ("done" as const) : i === 2 ? (firstPaid ? ("done" as const) : ("active" as const)) : firstPaid ? ("active" as const) : ("todo" as const),
    status: [
      "Reviewed",
      r.activatedAt ? `Done ${day(r.activatedAt)}` : "Done",
      firstPaid ? `Paid${lastPaid ? ` ${day(lastPaid)}` : ""}` : "PayPal is collecting it",
      next ? `Next ${day(next)}` : firstPaid ? "Every month" : undefined,
    ][i],
  }));

  return (
    <div className="grid gap-8">
      <StepBar label="Monthly retainer" steps={steps} />
      <section className="grid gap-3 pt-4">
        <span aria-hidden className="grid h-10 w-10 place-items-center rounded-full bg-cleared text-xl text-white">
          ✓
        </span>
        <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl">Your retainer is set up</h1>
        <p className="max-w-[60ch] text-lg leading-relaxed text-muted">
          {money(r.amount, r.currency)} a month to {freelancer} for {r.description}. PayPal handles the billing and emails you each receipt.
        </p>
      </section>

      <p className="text-sm leading-relaxed text-muted">
        To stop the retainer, cancel it in your PayPal account under automatic payments, or ask {freelancer}. Nothing more is billed after
        that.
      </p>
    </div>
  );
}
