import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { Steps, type StepState } from "@/components/connect/Steps";
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
  const steps: StepState[] = ["done", firstPaid ? "done" : "active", firstPaid ? "active" : "todo"];

  return (
    <div className="grid gap-8">
      <section className="grid gap-3 pt-4">
        <span aria-hidden className="grid h-10 w-10 place-items-center rounded-full bg-cleared text-xl text-white">
          ✓
        </span>
        <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl">Your retainer is set up</h1>
        <p className="max-w-[60ch] text-lg leading-relaxed text-muted">
          {money(r.amount, r.currency)} a month to {freelancer} for {r.description}. PayPal handles the billing and emails you each receipt.
        </p>
      </section>

      <section className="grid gap-4 rounded-xl border border-line bg-card p-6">
        <h2 className="font-display text-2xl font-semibold tracking-tight">Status</h2>
        <Steps
          items={[
            { title: "Approved on PayPal", body: "Your monthly retainer is active.", state: steps[0] },
            {
              title: "First month paid",
              body: firstPaid ? `Paid${lastPaid ? ` on ${day(lastPaid)}` : ""}. PayPal emailed you the receipt.` : "PayPal is collecting the first month now. Refresh this page in a minute to see the receipt date.",
              state: steps[1],
            },
            {
              title: "Next monthly payment",
              body: next ? `PayPal bills ${money(r.amount, r.currency)} on ${day(next)}.` : "PayPal bills the same amount each month.",
              state: steps[2],
            },
          ]}
        />
      </section>

      <p className="text-sm leading-relaxed text-muted">
        To stop the retainer, cancel it in your PayPal account under automatic payments, or ask {freelancer}. Nothing more is billed after
        that.
      </p>
    </div>
  );
}
