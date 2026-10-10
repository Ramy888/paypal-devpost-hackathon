// Payment schedules: a job split into dated parts the client approves once.
// Milestones: each part is its own PayPal invoice. Chunks: one invoice paid in parts.
// Pure: no I/O. Dates are YYYY-MM-DD strings, compared as strings.

const DAY_MS = 86_400_000;
export const MODES = ["milestones", "chunks"];
export const SEND_DAYS_BEFORE = 3;
export const MAX_PARTS = 12;
const CLOSED = new Set(["paid", "cancelled"]);

const day = (d) => new Date(d).toISOString().slice(0, 10);
const cents = (n) => Math.round(Number(n) * 100);
const money = (n) => (cents(n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bySeq = (parts) => [...parts].sort((a, b) => a.seq - b.seq);
const isOpen = (p) => !CLOSED.has(p.status) && p.status !== "on_hold";

export class ScheduleError extends Error {}

/** Amounts for each percentage, summing exactly to `total`; the last part takes the rounding. */
export function splitByPercent(total, percents) {
  const sum = percents.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.001) throw new ScheduleError(`Percentages must add up to 100 (they add up to ${sum}).`);
  const out = percents.slice(0, -1).map((p) => Math.round(cents(total) * (p / 100)) / 100);
  out.push((cents(total) - out.reduce((a, b) => a + cents(b), 0)) / 100);
  return out;
}

export function validateSchedule({ mode, total, parts }, today = new Date()) {
  if (!MODES.includes(mode)) throw new ScheduleError("Choose milestones or chunks.");
  if (!Array.isArray(parts) || parts.length < 2) throw new ScheduleError("A schedule needs at least 2 parts.");
  if (parts.length > MAX_PARTS) throw new ScheduleError(`A schedule can have at most ${MAX_PARTS} parts.`);
  const todayDay = day(today);
  let prev = "";
  for (const p of bySeq(parts)) {
    if (!(Number(p.amount) > 0)) throw new ScheduleError(`"${p.name || `Part ${p.seq}`}" needs an amount of more than zero.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate ?? "")) throw new ScheduleError(`"${p.name || `Part ${p.seq}`}" needs a due date.`);
    if (p.dueDate < todayDay) throw new ScheduleError(`"${p.name || `Part ${p.seq}`}" has a due date in the past.`);
    if (p.dueDate < prev) throw new ScheduleError("Parts must be in date order.");
    prev = p.dueDate;
  }
  const sum = parts.reduce((t, p) => t + cents(p.amount), 0);
  if (sum !== cents(total)) throw new ScheduleError(`Parts must add up to ${money(total)} (they add up to ${money(sum / 100)}).`);
}

/** Milestone invoices to create and send now: approved, not yet sent, due within SEND_DAYS_BEFORE days. */
export function partsToSend({ schedule, parts, today }) {
  if (schedule.mode !== "milestones" || schedule.status !== "approved") return [];
  const sendBy = day(new Date(today).getTime() + SEND_DAYS_BEFORE * DAY_MS);
  return bySeq(parts).filter((p) => p.status === "scheduled" && p.dueDate <= sendBy);
}

/** Parts auto-pay should charge today, and due parts it may not charge because they exceed the limit. */
export function partsToCharge({ schedule, parts, today, spendLimit }) {
  if (schedule.status !== "approved" || !schedule.autopay) return { charge: [], overLimit: [] };
  const todayDay = day(today);
  const due = bySeq(parts).filter(
    (p) => isOpen(p) && p.dueDate <= todayDay && (schedule.mode === "chunks" || (p.status === "sent" && p.invoiceId)),
  );
  return {
    charge: due.filter((p) => cents(p.amount) <= cents(spendLimit)),
    overLimit: due.filter((p) => cents(p.amount) > cents(spendLimit)),
  };
}

/** The earliest part still to be paid that the client hasn't put on hold, or null. */
export function nextOpenPart(parts) {
  return bySeq(parts).find(isOpen) ?? null;
}

/**
 * Chunks: spreads money the client paid on PayPal (beyond the parts already marked paid) over
 * the remaining parts in order. A part counts as paid only in full, money never goes to a part
 * on hold, and money that paid one part is never counted again for another.
 */
export function allocatePaid(parts, paidTotal) {
  const sorted = bySeq(parts);
  let left = cents(paidTotal) - sorted.filter((p) => p.status === "paid").reduce((t, p) => t + cents(p.amount), 0);
  let stopped = false;
  return sorted.map((p) => {
    if (!isOpen(p)) return p;
    if (!stopped && left >= cents(p.amount)) {
      left -= cents(p.amount);
      return { ...p, status: "paid" };
    }
    stopped = true;
    return p;
  });
}

/** The client's "Not done yet": holds this one part; nothing is charged or chased until it is resolved. */
export function holdPart(p, { note = "", at = new Date() } = {}) {
  if (p.status === "paid") throw new ScheduleError("This part is already paid.");
  if (p.status === "cancelled") throw new ScheduleError("This part was cancelled.");
  if (p.status === "on_hold") return p;
  return { ...p, status: "on_hold", statusBeforeHold: p.status, holdNote: String(note).slice(0, 500), heldAt: at };
}

/** The freelancer proposes a new due date for a held part; it waits for the client's approval. */
export function proposeNewDate(p, dueDate, today = new Date()) {
  if (p.status !== "on_hold") throw new ScheduleError("Only a part on hold gets a new date.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate ?? "") || dueDate < day(today)) throw new ScheduleError("The new date can't be in the past.");
  return { ...p, proposedDueDate: dueDate };
}

/** The client approves the proposed date: the hold ends and the part is due on the new date. */
export function approveNewDate(p) {
  if (!p.proposedDueDate) throw new ScheduleError("There is no new date to approve.");
  return { ...p, dueDate: p.proposedDueDate, proposedDueDate: null, status: p.statusBeforeHold ?? "scheduled", statusBeforeHold: null, holdNote: "" };
}

/** The client lifts the hold: the part is due on its original date again. */
export function releaseHold(p) {
  if (p.status !== "on_hold") throw new ScheduleError("This part is not on hold.");
  return { ...p, status: p.statusBeforeHold ?? "scheduled", statusBeforeHold: null, proposedDueDate: null, holdNote: "" };
}

/**
 * What the dashboard and reminders need to know about invoices that belong to a schedule,
 * keyed by PayPal invoice id: a project label, whether the client put it on hold, and the
 * date it is really due (a chunked invoice is due when its next part is).
 */
export function scheduleOverrides(schedules, parts) {
  const out = new Map();
  for (const s of schedules) {
    const own = bySeq(parts.filter((p) => p.scheduleId === s.id));
    if (!own.length) continue;
    if (s.mode === "milestones") {
      for (const p of own) {
        if (p.invoiceId) out.set(p.invoiceId, { project: `${s.title} · ${p.seq}/${own.length}`, held: p.status === "on_hold", dueDate: p.dueDate });
      }
    } else if (s.invoiceId) {
      const next = nextOpenPart(own);
      const paidCount = own.filter((p) => p.status === "paid").length;
      out.set(s.invoiceId, {
        project: `${s.title} · ${paidCount}/${own.length} parts paid`,
        held: !next && own.some((p) => p.status === "on_hold"),
        dueDate: (next ?? own.at(-1)).dueDate,
      });
    }
  }
  return out;
}
