import type { Metadata } from "next";
import Link from "next/link";
import { OwnerHeader } from "@/components/OwnerHeader";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { pgStore } from "@/lib/server/db.mjs";
import { clockOffsetDays, now } from "@/lib/server/clock.mjs";
import { isOwner } from "@/lib/server/owner";
import { ownerIsPro } from "@/lib/server/pro";
import { approveAndSend, cancelReminder, checkNow, jumpClock, resetClock, saveEdits } from "./actions";

export const metadata: Metadata = { title: "Reminders · CollectPilot" };

type Reminder = {
  id: string;
  invoiceNumber: string;
  clientEmail: string;
  stage: number;
  daysOverdue: number;
  amount: number;
  currency: string;
  riskBucket: string;
  riskReason: string;
  subject: string;
  body: string;
  edited: boolean;
  status: "drafted" | "sent" | "cancelled";
  cancelReason: string | null;
  autoSendAt: string | Date;
  sentAt: string | Date | null;
  sentBy: string | null;
};

const fmtDate = (d: Date | string) => new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const money = (n: number, c: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
const RISK = {
  low: "bg-cleared-soft text-cleared",
  medium: "bg-pending-soft text-pending",
  high: "bg-ink text-white",
} as const;
const STAGE = ["", "Friendly nudge", "Follow-up", "Final notice"];

function ReminderCard({ r, today, pro }: { r: Reminder; today: Date; pro: boolean }) {
  const hoursLeft = Math.max(0, Math.round((new Date(r.autoSendAt).getTime() - today.getTime()) / 3_600_000));
  return (
    <article className={`grid gap-4 rounded-xl border bg-card p-5 ${r.status === "drafted" ? "border-ink" : "border-line"}`}>
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono">{r.invoiceNumber}</span>
        <span className="text-muted">·</span>
        <span className="tabular-nums">{money(r.amount, r.currency)}</span>
        <span className="text-muted">· {r.daysOverdue} days overdue · {STAGE[r.stage]}</span>
        <span className={`ms-auto rounded-full px-2.5 py-0.5 text-xs font-semibold ${RISK[r.riskBucket as keyof typeof RISK] ?? RISK.medium}`}>
          {r.riskBucket} risk
        </span>
      </header>
      <p className="text-sm text-muted">{r.riskReason}</p>

      {r.status === "drafted" ? (
        <form action={saveEdits.bind(null, r.id)} className="grid gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-muted">Subject</span>
            <input name="subject" dir="auto" defaultValue={r.subject} className="rounded-md border border-line bg-paper px-3 py-2" />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted">Message to {r.clientEmail}</span>
            <textarea name="body" dir="auto" rows={5} defaultValue={r.body} className="rounded-md border border-line bg-paper px-3 py-2 leading-relaxed" />
          </label>
          <p className="rounded-md bg-pending-soft px-3 py-2 text-sm text-pending">
            {pro ? (
              <>Sends automatically on {fmtDate(r.autoSendAt)} (in about {hoursLeft} hours, demo time) unless you change or cancel it.</>
            ) : (
              <>
                Waits for you to approve it. With <Link href="/billing" className="font-semibold underline">Pro</Link>, the autopilot sends it on{" "}
                {fmtDate(r.autoSendAt)} unless you change or cancel it.
              </>
            )}
            {r.edited ? " You edited this message." : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <button formAction={approveAndSend.bind(null, r.id)} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white">
              Approve &amp; send now
            </button>
            <button className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold">Save edits</button>
            <button formAction={cancelReminder.bind(null, r.id)} className="rounded-lg px-4 py-2.5 text-sm font-semibold text-pending hover:bg-pending-soft">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="grid gap-1 text-sm">
          <p className="font-medium" dir="auto">
            {r.subject}
          </p>
          <p className="whitespace-pre-line text-muted" dir="auto">
            {r.body}
          </p>
          <p className="pt-2 text-xs text-muted">
            {r.status === "sent"
              ? `Sent ${r.sentAt ? fmtDate(r.sentAt) : ""} by ${r.sentBy === "autopilot" ? "the autopilot (nobody changed it in time)" : "you"} through PayPal.`
              : `Cancelled: ${r.cancelReason}.`}
          </p>
        </div>
      )}
    </article>
  );
}

export default async function RemindersPage() {
  await connection();
  if (!(await isOwner())) redirect("/login");
  const [reminders, today, offset, pro]: [Reminder[], Date, number, boolean] = await Promise.all([
    pgStore().listReminders(),
    now(),
    clockOffsetDays(),
    ownerIsPro(),
  ]);
  const pending = reminders.filter((r) => r.status === "drafted");
  const done = reminders.filter((r) => r.status !== "drafted");

  return (
    <div className="min-h-full bg-paper">
      <OwnerHeader current="/reminders" />
      <main className="mx-auto grid max-w-3xl gap-8 px-5 pb-16">
        <section className="grid gap-2 pt-2">
          <h1 className="font-display text-4xl font-semibold tracking-tight">Reminders</h1>
          <p className="text-muted">
            The agent drafts a reminder when an invoice is overdue and sends it a day later unless you edit or cancel it. PayPal
            delivers it and copies you.
          </p>
        </section>

        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line bg-card p-4 text-sm">
          <span className="font-medium">
            Demo clock: {fmtDate(today)} {offset > 0 && <span className="text-pending">(+{offset} days)</span>}
          </span>
          <form action={jumpClock.bind(null, 1)}>
            <button className="rounded-md border border-line px-3 py-1.5 font-semibold">+1 day</button>
          </form>
          <form action={jumpClock.bind(null, 3)}>
            <button className="rounded-md border border-line px-3 py-1.5 font-semibold">+3 days</button>
          </form>
          <form action={jumpClock.bind(null, 7)}>
            <button className="rounded-md border border-line px-3 py-1.5 font-semibold">+7 days</button>
          </form>
          <form action={checkNow}>
            <button className="rounded-md border border-line px-3 py-1.5 font-semibold">Check now</button>
          </form>
          {offset > 0 && (
            <form action={resetClock} className="ms-auto">
              <button className="text-muted underline-offset-2 hover:underline">Back to today</button>
            </form>
          )}
        </section>

        <section className="grid gap-4">
          <h2 className="font-display text-2xl font-semibold tracking-tight">Waiting for you ({pending.length})</h2>
          {pending.length === 0 ? (
            <p className="text-muted">Nothing to review. Overdue invoices get a draft here automatically.</p>
          ) : (
            pending.map((r) => <ReminderCard key={r.id} r={r} today={today} pro={pro} />)
          )}
        </section>

        {done.length > 0 && (
          <section className="grid gap-4">
            <h2 className="font-display text-2xl font-semibold tracking-tight">History</h2>
            {done.map((r) => (
              <ReminderCard key={r.id} r={r} today={today} pro={pro} />
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
