import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Notice } from "@/components/connect/Notice";
import { StepBar } from "@/components/StepBar";
import { scheduleSteps } from "@/components/journeys";
import { freelancerName, loadByPublicId } from "@/lib/server/schedules";
import { now } from "@/lib/server/clock.mjs";
import { approveWithoutAutopay, approveNewDate, holdPart, releaseHold, turnOffAutopay } from "../actions";

export const metadata: Metadata = { title: "Payment schedule · CollectPilot", robots: { index: false } };

type Part = {
  id: string;
  seq: number;
  name: string;
  amount: number;
  dueDate: string;
  status: "scheduled" | "sent" | "paid" | "on_hold" | "cancelled";
  holdNote: string;
  proposedDueDate: string | null;
};
type Charge = { partId: string; outcome: "captured" | "failed" | "unconfirmed" | "over_limit"; attemptedAt: string | Date; detail: string };

const money = (n: number, c: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
const date = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });

const DONE: Record<string, string> = {
  approved: "Schedule approved. Each part is invoiced by PayPal; pay them as they come.",
  "autopay-on": "Auto-pay is on. Each part is charged on its date unless you mark it “Not done yet”.",
  "autopay-off": "Auto-pay is off. Nothing will be charged automatically; pay each PayPal invoice yourself.",
  held: "Marked “Not done yet”. That part won't be charged or chased until it's sorted out. The other parts are unchanged.",
  released: "Hold lifted. That part is due on its original date again.",
  date: "New date approved.",
};
const PROBLEM: Record<string, string> = {
  paypal: "PayPal couldn't finish that just now. Nothing was charged. Please try again in a minute.",
  busy: "Too many tries in a short time. Please wait a few minutes and try again.",
};

function StatusChip({ part, autopay }: { part: Part; autopay: boolean }) {
  const map: Record<Part["status"], [string, string]> = {
    paid: ["Paid", "bg-cleared-soft text-cleared"],
    on_hold: ["Not done yet", "bg-pending-soft text-pending"],
    sent: [autopay ? "Invoiced · auto-pay on its date" : "Invoiced", "bg-line text-ink"],
    scheduled: [autopay ? "Auto-pay on its date" : "Scheduled", "bg-line text-ink"],
    cancelled: ["Cancelled", "bg-line text-muted"],
  };
  const [label, cls] = map[part.status];
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>;
}

export default async function SchedulePage({ params, searchParams }: PageProps<"/pay/[publicId]">) {
  await connection();
  const { publicId } = await params;
  const { done, error, problem } = await searchParams;
  const found = await loadByPublicId(publicId);
  if (!found) notFound();
  const { schedule } = found;
  const parts = found.parts as Part[];
  const charges = found.charges as Charge[];
  const freelancer = freelancerName();
  const today = (await now()).toISOString().slice(0, 10);
  const largest = Math.max(...parts.filter((p) => p.status !== "paid").map((p) => p.amount), 0);
  const paid = parts.filter((p) => p.status === "paid").reduce((t, p) => t + p.amount, 0);
  const kind = schedule.mode === "milestones" ? "milestone" : "part";

  if (schedule.status === "cancelled") {
    return <Notice title="This schedule is no longer active" body={`${freelancer} cancelled this payment schedule, so nothing will be invoiced or charged.`} />;
  }

  return (
    <div className="grid gap-8">
      <StepBar
        label="Payment schedule"
        steps={scheduleSteps({ approved: schedule.status === "approved", autopay: schedule.autopay, kind, paid: parts.filter((p) => p.status === "paid").length, total: parts.length, held: parts.filter((p) => p.status === "on_hold").length })}
      />
      <section className="grid gap-3 pt-4">
        <p className="text-sm font-medium text-cleared">
          {schedule.status === "proposed" ? `A payment schedule from ${freelancer}` : `Your payment schedule with ${freelancer}`}
        </p>
        <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl" dir="auto">
          {schedule.title}
        </h1>
        <p className="max-w-[60ch] text-lg leading-relaxed text-muted">
          {money(schedule.total, schedule.currency)} in {parts.length} {kind}s
          {schedule.mode === "milestones" ? ", each invoiced by PayPal 3 days before its date." : ", all on one PayPal invoice you pay in parts."}
          {schedule.status === "approved" && ` ${money(paid, schedule.currency)} paid so far.`}
        </p>
      </section>

      {typeof done === "string" && DONE[done] && <p className="rounded-lg border border-cleared/30 bg-cleared-soft px-4 py-3 text-sm text-cleared">{DONE[done]}</p>}
      {typeof error === "string" && (
        <p role="alert" className="rounded-lg border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
          {error}
        </p>
      )}
      {typeof problem === "string" && PROBLEM[problem] && (
        <p role="alert" className="rounded-lg border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
          {PROBLEM[problem]}
        </p>
      )}

      <ol aria-label="Schedule" className="grid gap-3">
        {parts.map((p) => {
          const tried = charges.filter((c) => c.partId === p.id && c.outcome !== "captured").at(-1);
          const open = p.status !== "paid" && p.status !== "cancelled";
          return (
            <li key={p.id} className={`grid gap-3 rounded-xl border bg-card p-5 ${p.status === "on_hold" ? "border-pending/40" : "border-line"}`}>
              <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1">
                <p className="min-w-0 font-medium" dir="auto">
                  <span className="text-muted tabular-nums">{p.seq}. </span>
                  {p.name}
                </p>
                <p className="font-display text-xl font-semibold tabular-nums">{money(p.amount, schedule.currency)}</p>
                <p className="text-sm text-muted">
                  Due {date(p.dueDate)}
                  {p.dueDate <= today && open && p.status !== "on_hold" ? " · due now" : ""}
                </p>
                {schedule.status === "approved" && (
                  <div className="justify-self-end">
                    <StatusChip part={p} autopay={schedule.autopay} />
                  </div>
                )}
              </div>

              {p.status === "on_hold" && (
                <div className="grid gap-2 rounded-lg bg-pending-soft/60 p-3 text-sm">
                  {p.holdNote && (
                    <p dir="auto">
                      <span className="text-muted">Your note: </span>
                      {p.holdNote}
                    </p>
                  )}
                  {p.proposedDueDate ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <p>
                        {freelancer} proposes a new date: <strong>{date(p.proposedDueDate)}</strong>
                      </p>
                      <form action={approveNewDate.bind(null, publicId, p.id)}>
                        <button className="rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-white">Approve new date</button>
                      </form>
                    </div>
                  ) : (
                    <p className="text-muted">Waiting for {freelancer} to propose a new date.</p>
                  )}
                  <form action={releaseHold.bind(null, publicId, p.id)}>
                    <button className="text-sm font-medium text-cleared hover:underline">It&apos;s done now: lift the hold</button>
                  </form>
                </div>
              )}

              {schedule.status === "approved" && open && p.status !== "on_hold" && (
                <details className="text-sm">
                  <summary className="cursor-pointer w-fit font-medium text-pending">Not done yet?</summary>
                  <form action={holdPart.bind(null, publicId, p.id)} className="mt-2 grid gap-2">
                    <label htmlFor={`note-${p.id}`} className="text-muted">
                      Tell {freelancer} what&apos;s missing (optional). This {kind} won&apos;t be charged or chased; the others stay as they are.
                    </label>
                    <textarea id={`note-${p.id}`} name="note" rows={2} maxLength={500} dir="auto" className="w-full min-w-0 rounded-md border border-line bg-paper px-3 py-2" />
                    <button className="w-fit rounded-md border border-pending/40 bg-pending-soft px-3 py-1.5 font-semibold text-pending">Mark “Not done yet”</button>
                  </form>
                </details>
              )}

              {tried && open && (
                <p className="text-xs text-pending">
                  Auto-pay didn&apos;t charge this {kind}: {tried.outcome === "over_limit" ? "it's over your auto-pay limit" : tried.detail}. Pay it from the PayPal invoice instead.
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {schedule.status === "proposed" ? (
        <section className="grid gap-4 rounded-xl border-2 border-ink bg-card p-6">
          <h2 className="font-display text-2xl font-semibold tracking-tight">Approve these dates</h2>
          <form action="/pay/start" method="post" className="grid gap-2">
            <input type="hidden" name="s" value={publicId} />
            <button type="submit" className="rounded-lg bg-ink px-5 py-3.5 text-base font-semibold text-white hover:bg-ink/90">
              Approve and turn on auto-pay with PayPal
            </button>
            <p className="text-sm text-muted">
              Approve CollectPilot once on PayPal. Each {kind} is then charged on its date, up to {money(largest, schedule.currency)} per charge. Mark any {kind}{" "}
              “Not done yet” and it isn&apos;t charged. Nothing is charged today unless a {kind} is due today.
            </p>
          </form>
          <form action={approveWithoutAutopay.bind(null, publicId)} className="grid gap-1 border-t border-line pt-4">
            <button className="w-fit text-sm font-semibold text-cleared hover:underline">Approve, and I&apos;ll pay each PayPal invoice myself</button>
          </form>
        </section>
      ) : (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card p-5 text-sm">
          {schedule.autopay ? (
            <>
              <p className="min-w-0 flex-1">
                <strong>Auto-pay is on.</strong> Each {kind} is charged on its date with your PayPal approval, up to your limit per charge.
              </p>
              <form action={turnOffAutopay.bind(null, publicId)}>
                <button className="rounded-md border border-line px-3 py-1.5 font-semibold">Turn off auto-pay</button>
              </form>
            </>
          ) : (
            <>
              <p className="min-w-0 flex-1">
                <strong>Auto-pay is off.</strong> PayPal emails each invoice; pay it there, or let your AI assistant pay it.
              </p>
              <form action="/pay/start" method="post">
                <input type="hidden" name="s" value={publicId} />
                <button className="rounded-md bg-ink px-3 py-1.5 font-semibold text-white">Turn on auto-pay</button>
              </form>
            </>
          )}
        </section>
      )}
    </div>
  );
}
