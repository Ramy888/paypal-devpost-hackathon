import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { OwnerHeader } from "@/components/OwnerHeader";
import { scheduleLink } from "@/lib/scheduleOps.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { now } from "@/lib/server/clock.mjs";
import { isOwner } from "@/lib/server/owner";
import { proposeDate, markFixed, freelancerReply } from "./actions";
import { NotDoneDialog } from "@/components/pay/NotDoneDialog";
import { Thread, type Message } from "@/components/pay/Thread";

export const metadata: Metadata = { title: "Schedules · CollectPilot" };

type Schedule = { id: string; publicId: string; mode: "milestones" | "chunks"; title: string; clientEmail: string; clientName: string; currency: string; total: number; status: string; autopay: boolean; invoiceId: string | null };
type Part = { id: string; scheduleId: string; seq: number; name: string; amount: number; dueDate: string; status: string; holdNote: string; proposedDueDate: string | null; autopay: boolean; fixedAt: string | Date | null };
type Charge = { partId: string; outcome: string; detail: string };

const money = (n: number, c: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
const date = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
const DONE: Record<string, string> = {
  proposed: "New date sent to your client to approve.",
  fixed: "Marked fixed. Your client confirms before it's due again.",
  replied: "Reply sent.",
};
const STATUS: Record<string, [string, string]> = {
  scheduled: ["Scheduled", "bg-line text-ink"],
  sent: ["Invoiced", "bg-line text-ink"],
  paid: ["Paid", "bg-cleared-soft text-cleared"],
  on_hold: ["Client: not done yet", "bg-pending-soft text-pending"],
  fixed: ["Fixed · client to confirm", "bg-cleared-soft text-cleared"],
  cancelled: ["Cancelled", "bg-line text-muted"],
};

export default async function SchedulesPage({ searchParams }: PageProps<"/schedules">) {
  await connection();
  if (!(await isOwner())) redirect("/login");
  const { done, error } = await searchParams;
  const store = pgStore();
  const schedules: Schedule[] = await store.listSchedules();
  const parts: Part[] = await store.listAllParts();
  const charges: Charge[] = parts.length ? await store.listCharges(parts.map((p) => p.id)) : [];
  const messages: Message[] = parts.length ? await store.listMessages(parts.map((p) => p.id)) : [];
  const today = (await now()).toISOString().slice(0, 10);
  const appUrl = process.env.APP_URL!;

  return (
    <div className="min-h-full bg-paper">
      <OwnerHeader current="/schedules" />
      <main className="mx-auto grid max-w-3xl gap-6 px-5 pb-16">
        <section className="grid gap-2 pt-2">
          <h1 className="font-display text-4xl font-semibold tracking-tight">Payment schedules</h1>
          <p className="text-muted">
            Jobs split into milestones. Your client approves the dates once; with auto-pay on, each part is charged on its date unless they mark it “Not done yet”.
          </p>
          <Link href="/invoices/new" className="w-fit text-sm font-semibold text-cleared hover:underline">
            + New schedule (choose Milestones when you review the invoice)
          </Link>
        </section>

        {typeof done === "string" && DONE[done] && <p className="rounded-lg border border-cleared/30 bg-cleared-soft px-4 py-3 text-sm text-cleared">{DONE[done]}</p>}
        {typeof error === "string" && (
          <p role="alert" className="rounded-lg border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
            {error}
          </p>
        )}
        {schedules.length === 0 && <p className="rounded-xl border border-dashed border-line p-6 text-sm text-muted">No schedules yet.</p>}

        {schedules.map((s) => {
          const own = parts.filter((p) => p.scheduleId === s.id);
          const paid = own.filter((p) => p.status === "paid").reduce((t, p) => t + p.amount, 0);
          const link = scheduleLink(appUrl, s);
          return (
            <article key={s.id} className="grid gap-4 rounded-xl border border-line bg-card p-5">
              <header className="grid gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-display text-xl font-semibold tracking-tight" dir="auto">
                    {s.title}
                  </h2>
                  <p className="font-display text-xl font-semibold tabular-nums">{money(s.total, s.currency)}</p>
                </div>
                <p className="text-sm text-muted">
                  {s.clientName || s.clientEmail} · {own.length} {s.mode === "milestones" ? "milestones" : "parts"} · {money(paid, s.currency)} paid ·{" "}
                  {s.status === "proposed" ? (
                    <span className="font-semibold text-pending">waiting for the client to approve</span>
                  ) : s.autopay ? (
                    <span className="font-semibold text-cleared">auto-pay on</span>
                  ) : (
                    "client pays each invoice"
                  )}
                </p>
                <p className="min-w-0 truncate text-xs text-muted">
                  Client link: <code>{link}</code>
                </p>
                {s.mode === "chunks" && s.status === "approved" && !s.invoiceId && (
                  <p role="alert" className="mt-1 rounded-md bg-pending-soft px-3 py-2 text-xs text-pending">
                    PayPal hasn&apos;t accepted this schedule&apos;s invoice yet, so nothing can be charged. CollectPilot retries every 10 minutes; if this stays, check the client&apos;s email ({s.clientEmail}).
                  </p>
                )}
              </header>
              <ol className="grid gap-2">
                {own.map((p) => {
                  const [label, cls] = STATUS[p.status === "on_hold" && p.fixedAt ? "fixed" : p.status] ?? STATUS.scheduled;
                  const thread = messages.filter((m) => m.partId === p.id);
                  const problem = charges.filter((c) => c.partId === p.id && c.outcome !== "captured").at(-1);
                  return (
                    <li key={p.id} className="grid gap-2 border-t border-line pt-2 text-sm">
                      <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3">
                        <span className="min-w-0" dir="auto">
                          {p.seq}. {p.name} <span className="text-muted">· {date(p.dueDate)}{p.dueDate < today && p.status !== "paid" && p.status !== "on_hold" ? " · overdue" : ""}</span>
                        </span>
                        <span className="tabular-nums">{money(p.amount, s.currency)}</span>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>
                      </div>
                      {s.status === "approved" && !p.autopay && p.status !== "paid" && <p className="text-xs text-muted">Client switched auto-pay off for this one; they pay its PayPal invoice.</p>}
                      {p.status === "on_hold" && (
                        <div className="grid gap-3 rounded-lg bg-pending-soft/60 p-3">
                          {thread.length > 0 && <Thread messages={thread} freelancer="You" client={s.clientName || "Client"} viewer="freelancer" />}
                          {p.fixedAt ? (
                            <p className="text-muted">You marked it fixed. Waiting for the client to confirm.</p>
                          ) : p.proposedDueDate ? (
                            <p className="text-muted">You proposed {date(p.proposedDueDate)}. Waiting for the client to approve it.</p>
                          ) : null}
                          <form action={freelancerReply.bind(null, p.id)} className="flex gap-2">
                            <input name="body" required maxLength={1000} dir="auto" placeholder="Reply to your client" aria-label="Reply to your client" className="min-w-0 flex-1 rounded-md border border-line bg-paper px-3 py-1.5" />
                            <button className="rounded-md border border-line bg-card px-3 py-1.5 font-semibold">Send</button>
                          </form>
                          <div className="flex flex-wrap items-center gap-2">
                            {!p.fixedAt && (
                              <NotDoneDialog
                                action={markFixed.bind(null, p.id)}
                                label="Mark fixed"
                                title={`What did you fix in “${p.name}”?`}
                                prompt="Your client sees this and confirms before the milestone is due again."
                                submitLabel="Mark fixed"
                              />
                            )}
                            {!p.proposedDueDate && (
                              <form action={proposeDate.bind(null, p.id)} className="flex flex-wrap items-center gap-2">
                                <label htmlFor={`date-${p.id}`} className="text-muted">
                                  New due date
                                </label>
                                <input id={`date-${p.id}`} name="dueDate" type="date" min={today} required className="rounded-md border border-line bg-paper px-2 py-1 tabular-nums" />
                                <button className="rounded-md bg-ink px-3 py-1 font-semibold text-white">Propose</button>
                              </form>
                            )}
                          </div>
                        </div>
                      )}
                      {problem && p.status !== "paid" && (
                        <p className="text-xs text-pending">Auto-pay didn&apos;t charge this part: {problem.outcome === "over_limit" ? "over the client's limit" : problem.detail}. Reminders will follow up.</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </article>
          );
        })}
      </main>
    </div>
  );
}
