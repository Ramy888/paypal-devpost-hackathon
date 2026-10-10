import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Notice } from "@/components/connect/Notice";
import { StepBar } from "@/components/StepBar";
import { scheduleSteps } from "@/components/journeys";
import { freelancerName, loadByPublicId } from "@/lib/server/schedules";
import { now } from "@/lib/server/clock.mjs";
import { approveWithoutAutopay, approveNewDate, holdPart, releaseHold, turnOffAutopay, confirmFixed, stillNotDone, clientReply, setPartAutopay } from "../actions";
import { NotDoneDialog } from "@/components/pay/NotDoneDialog";
import { SwitchButton } from "@/components/pay/Switch";
import { Thread, type Message } from "@/components/pay/Thread";

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
  autopay: boolean;
  fixedAt: string | Date | null;
};
type Charge = { partId: string; outcome: "captured" | "failed" | "unconfirmed" | "over_limit"; attemptedAt: string | Date; detail: string };

const money = (n: number, c: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
const date = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });

const DONE: Record<string, string> = {
  approved: "Schedule approved. Each part is invoiced by PayPal; pay them as they come.",
  "autopay-on": "Auto-pay is on. Each part is charged on its date unless you mark it “Not done yet”.",
  "autopay-off": "Auto-pay is off. Nothing will be charged automatically; pay each PayPal invoice yourself.",
  held: "Marked “Not done yet”. That part won't be charged or chased until it's sorted out. The other parts are unchanged.",
  confirmed: "Confirmed. That part is due on its date again.",
  still: "Sent. It stays on hold until it's fixed.",
  replied: "Reply sent.",
  released: "Hold lifted. That part is due on its original date again.",
  date: "New date approved.",
};
const PROBLEM: Record<string, string> = {
  paypal: "PayPal couldn't finish that just now. Nothing was charged. Please try again in a minute.",
  busy: "Too many tries in a short time. Please wait a few minutes and try again.",
};

function StatusChip({ part }: { part: Part }) {
  const map: Record<Part["status"], [string, string]> = {
    paid: ["Paid", "bg-cleared-soft text-cleared"],
    on_hold: [part.fixedAt ? "Fixed? Confirm" : "Not done yet", "bg-pending-soft text-pending"],
    sent: ["Invoiced", "bg-line text-ink"],
    scheduled: ["Scheduled", "bg-line text-ink"],
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
  const messages = found.messages as Message[];
  const approved = schedule.status === "approved";
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
      <StepBar
        label="Payment schedule"
        steps={scheduleSteps({ approved: schedule.status === "approved", autopay: schedule.autopay, kind, paid: parts.filter((p) => p.status === "paid").length, total: parts.length, held: parts.filter((p) => p.status === "on_hold").length })}
      />

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

      <section aria-label="Schedule" className="overflow-hidden rounded-xl border border-line bg-card">
        <div className={`hidden gap-3 border-b border-line px-5 py-2.5 text-xs font-medium uppercase tracking-wide text-muted sm:grid ${approved ? "sm:grid-cols-[1fr_7rem_6rem_7.5rem_4.5rem]" : "sm:grid-cols-[1fr_7rem_6rem]"}`}>
          <span>{kind[0].toUpperCase() + kind.slice(1)}</span>
          <span>Due</span>
          <span className="text-right">Amount</span>
          {approved && (
            <>
              <span>Status</span>
              <span className="text-right">Auto-pay</span>
            </>
          )}
        </div>
        <ol className="divide-y divide-line">
          {parts.map((p) => {
            const tried = charges.filter((c) => c.partId === p.id && c.outcome !== "captured").at(-1);
            const open = p.status !== "paid" && p.status !== "cancelled";
            const thread = messages.filter((m) => m.partId === p.id);
            return (
              <li key={p.id} className={`grid gap-3 px-5 py-4 ${p.status === "on_hold" ? "bg-pending-soft/40" : ""}`}>
                <div className={`grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 ${approved ? "sm:grid-cols-[1fr_7rem_6rem_7.5rem_4.5rem]" : "sm:grid-cols-[1fr_7rem_6rem]"}`}>
                  <p className="min-w-0 font-medium" dir="auto">
                    <span className="text-muted tabular-nums">{p.seq}. </span>
                    {p.name}
                  </p>
                  <p className="order-3 text-sm text-muted tabular-nums sm:order-none">
                    <span className="sm:hidden">Due </span>
                    {date(p.dueDate)}
                    {p.dueDate <= today && open && p.status !== "on_hold" ? <span className="text-pending"> · due now</span> : null}
                  </p>
                  <p className="text-right font-display text-lg font-semibold tabular-nums">{money(p.amount, schedule.currency)}</p>
                  {approved && (
                    <>
                      <div className="order-4 sm:order-none">
                        <StatusChip part={p} />
                      </div>
                      <div className="order-5 flex items-center justify-end gap-2 sm:order-none">
                        <span className="text-xs text-muted sm:hidden">Auto-pay</span>
                        {!open ? (
                          <span className="text-xs text-muted">—</span>
                        ) : schedule.autopay ? (
                          <form action={setPartAutopay.bind(null, publicId, p.id, !p.autopay)} className="grid justify-items-center gap-0.5">
                            <span className={`text-[11px] font-semibold uppercase tracking-wide ${p.autopay ? "text-cleared" : "text-muted"}`}>{p.autopay ? "On" : "Off"}</span>
                            <SwitchButton on={p.autopay} label={`Auto-pay for ${p.name}`} />
                          </form>
                        ) : (
                          <form action="/pay/start" method="post" className="grid justify-items-center gap-0.5">
                            <input type="hidden" name="s" value={publicId} />
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Off</span>
                            <SwitchButton on={false} label={`Turn on auto-pay (approve on PayPal) for ${p.name}`} />
                          </form>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {approved && open && p.status !== "on_hold" && (
                  <div>
                    <NotDoneDialog
                      action={holdPart.bind(null, publicId, p.id)}
                      title={`What's missing in “${p.name}”?`}
                      prompt={`${freelancer} sees this. This ${kind} won't be charged or chased until it's sorted out; the others stay as they are.`}
                      submitLabel="Mark not done yet"
                    />
                  </div>
                )}

                {p.status === "on_hold" && (
                  <div className="grid gap-3 rounded-lg border border-pending/30 bg-card p-3 text-sm">
                    <p className="font-semibold text-pending">
                      {p.fixedAt ? `${freelancer} says it's fixed. Is it done?` : p.proposedDueDate ? `${freelancer} proposes a new date: ${date(p.proposedDueDate)}` : `Not done yet · waiting for ${freelancer}`}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {p.fixedAt && (
                        <>
                          <form action={confirmFixed.bind(null, publicId, p.id)}>
                            <button className="rounded-md bg-cleared px-3 py-1.5 font-semibold text-white">Yes, it&apos;s done</button>
                          </form>
                          <NotDoneDialog action={stillNotDone.bind(null, publicId, p.id)} label="Still not done" title="What's still missing?" prompt={`Tell ${freelancer} what still needs fixing.`} />
                        </>
                      )}
                      {p.proposedDueDate && (
                        <form action={approveNewDate.bind(null, publicId, p.id)}>
                          <button className="rounded-md bg-ink px-3 py-1.5 font-semibold text-white">Approve {date(p.proposedDueDate)}</button>
                        </form>
                      )}
                      {!p.fixedAt && (
                        <form action={releaseHold.bind(null, publicId, p.id)}>
                          <button className="rounded-md px-2 py-1.5 font-medium text-cleared hover:underline">It&apos;s done now: lift the hold</button>
                        </form>
                      )}
                    </div>
                  </div>
                )}

                {thread.length > 0 && (
                  <details className="text-sm" open={p.status === "on_hold"}>
                    <summary className="w-fit cursor-pointer font-medium text-muted">Conversation ({thread.length})</summary>
                    <Thread messages={thread} freelancer={freelancer} client="Client" viewer="client" />
                    {p.status === "on_hold" && (
                      <form action={clientReply.bind(null, publicId, p.id)} className="mt-2 flex gap-2">
                        <input name="body" required maxLength={1000} dir="auto" placeholder={`Reply to ${freelancer}`} aria-label={`Reply to ${freelancer}`} className="min-w-0 flex-1 rounded-md border border-line bg-paper px-3 py-1.5" />
                        <button className="rounded-md border border-line px-3 py-1.5 font-semibold">Send</button>
                      </form>
                    )}
                  </details>
                )}

                {tried && open && (
                  <p className="text-xs text-pending">
                    {tried.outcome === "unconfirmed"
                      ? `PayPal is still confirming a charge for this ${kind}. Don't pay it again.`
                      : `Auto-pay didn't charge this ${kind}: ${tried.outcome === "over_limit" ? "it's over your auto-pay limit" : tried.detail}. Pay it from the PayPal invoice instead.`}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </section>

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
