import { ensureChunkInvoice, sendDueMilestones, chargeDueParts, reconcileInvoice } from "@/lib/scheduleOps.mjs";
import { scheduleOverrides } from "@/lib/schedules.mjs";
import { eventStore } from "@/lib/events.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal, paypalOrders } from "@/lib/server/paypal";
import { now } from "@/lib/server/clock.mjs";

export const freelancerName = () => process.env.FREELANCER_NAME ?? "Your freelancer";
export const isPublicId = (id: string) => /^[A-Za-z0-9_-]{22}$/.test(id);

/** A schedule, its parts and every auto-pay attempt, by the client's link. */
export async function loadByPublicId(publicId: string) {
  if (!isPublicId(publicId)) return null;
  const store = pgStore();
  const schedule = await store.findScheduleByPublicId(publicId);
  if (!schedule) return null;
  const parts = await store.listParts(schedule.id);
  const charges = parts.length ? await store.listCharges(parts.map((p: { id: string }) => p.id)) : [];
  return { schedule, parts, charges };
}

/**
 * One pass over approved schedules: make sure each chunked one has its invoice, send milestone
 * invoices that are coming due, and run auto-pay. Runs with the reminder agent, on the demo clock.
 * Auto-pay is the client's choice, so it does not depend on the freelancer's plan.
 */
export async function runSchedules() {
  const store = pgStore();
  const today = await now();
  const ctx = { freelancerName: freelancerName(), appUrl: process.env.APP_URL! };
  const summary = { sent: 0, charged: 0, failed: 0 };
  for (const listed of await store.listSchedules()) {
    if (listed.status !== "approved") continue;
    try {
      let schedule = listed;
      let parts = await store.listParts(schedule.id);
      if (schedule.mode === "chunks" && !schedule.invoiceId) {
        await ensureChunkInvoice({ store, paypal: paypal(), schedule, parts, ...ctx });
        schedule = await store.findSchedule(schedule.id);
      }
      summary.sent += (await sendDueMilestones({ store, paypal: paypal(), schedule, parts, today, ...ctx })).length;
      parts = await store.listParts(schedule.id);
      const payer = schedule.autopay && schedule.payerId ? await store.findPayer(schedule.payerId) : null;
      for (const r of await chargeDueParts({ store, paypal: paypal(), orders: paypalOrders(), schedule, parts, payer, today, eventStore })) {
        if (r.outcome === "captured") summary.charged++;
        else if (r.outcome !== "already_paid") summary.failed++;
      }
    } catch (err) {
      // One schedule's PayPal trouble must not stop the others.
      console.error(JSON.stringify({ msg: "schedule pass failed", schedule_id: listed.id, error: String(err) }));
    }
  }
  return summary;
}

/** After a verified invoice webhook: mark schedule parts paid. False when the invoice isn't a schedule's. */
export async function applyScheduleWebhook(invoiceId: string | null | undefined) {
  if (!invoiceId) return false;
  return reconcileInvoice({ store: pgStore(), paypal: paypal(), invoiceId, now: await now() });
}

/** Project labels, holds and real due dates for invoices that belong to a schedule. */
// Never throws: if schedules can't be read, the dashboard and reminders work as before without them.
export async function loadOverrides() {
  try {
    const store = pgStore();
    const [schedules, parts] = await Promise.all([store.listSchedules(), store.listAllParts()]);
    return scheduleOverrides(schedules, parts);
  } catch (err) {
    console.error(JSON.stringify({ msg: "schedule overrides unavailable", error: String(err) }));
    return new Map();
  }
}
