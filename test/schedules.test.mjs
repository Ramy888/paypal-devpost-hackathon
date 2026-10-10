import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitByPercent,
  validateSchedule,
  partsToSend,
  partsToCharge,
  nextOpenPart,
  allocatePaid,
  holdPart,
  proposeNewDate,
  approveNewDate,
  releaseHold,
  SEND_DAYS_BEFORE,
} from "../lib/schedules.mjs";

const TODAY = new Date("2026-11-03T09:00:00Z");
const part = (seq, amount, dueDate, over = {}) => ({ id: `P${seq}`, seq, name: `Part ${seq}`, amount, dueDate, status: "scheduled", ...over });
const schedule = (over = {}) => ({ id: "S1", mode: "milestones", total: 3000, currency: "USD", status: "approved", autopay: true, ...over });

test("splitByPercent sums exactly to the total, the last part taking the rounding", () => {
  assert.deepEqual(splitByPercent(3000, [30, 40, 30]), [900, 1200, 900]);
  assert.deepEqual(splitByPercent(100, [33.33, 33.33, 33.34]), [33.33, 33.33, 33.34]);
  const odd = splitByPercent(1000, [33, 33, 34]);
  assert.equal(Math.round(odd.reduce((a, b) => a + b, 0) * 100), 100000);
  assert.throws(() => splitByPercent(1000, [50, 40]), /add up to 100/);
});

test("validateSchedule: parts must be positive, dated, in order and sum to the total", () => {
  const ok = { mode: "chunks", total: 3000, parts: [part(1, 900, "2026-11-03"), part(2, 2100, "2026-12-03")] };
  assert.doesNotThrow(() => validateSchedule(ok, TODAY));
  assert.throws(() => validateSchedule({ ...ok, parts: [part(1, 900, "2026-11-03"), part(2, 2000, "2026-12-03")] }, TODAY), /add up to 3,000.00/);
  assert.throws(() => validateSchedule({ ...ok, parts: [part(1, 0, "2026-11-03"), part(2, 3000, "2026-12-03")] }, TODAY), /more than zero/);
  assert.throws(() => validateSchedule({ ...ok, parts: [part(1, 900, "2026-12-03"), part(2, 2100, "2026-11-03")] }, TODAY), /in date order/);
  assert.throws(() => validateSchedule({ ...ok, parts: [part(1, 900, "2026-10-01"), part(2, 2100, "2026-12-03")] }, TODAY), /in the past/);
  assert.throws(() => validateSchedule({ ...ok, parts: [part(1, 3000, "2026-11-03")] }, TODAY), /at least 2/);
  assert.throws(() => validateSchedule({ ...ok, mode: "weekly" }, TODAY), /milestones or chunks/);
});

test(`milestone invoices go out ${SEND_DAYS_BEFORE} days before their due date, only once the client approved`, () => {
  const parts = [part(1, 900, "2026-11-03"), part(2, 1200, "2026-11-06"), part(3, 900, "2026-11-20")];
  assert.deepEqual(partsToSend({ schedule: schedule(), parts, today: TODAY }).map((p) => p.id), ["P1", "P2"]);
  assert.deepEqual(partsToSend({ schedule: schedule({ status: "proposed" }), parts, today: TODAY }), []);
  assert.deepEqual(partsToSend({ schedule: schedule({ mode: "chunks" }), parts, today: TODAY }), [], "chunks share one invoice sent at approval");
  const sent = parts.map((p) => (p.id === "P1" ? { ...p, status: "sent", invoiceId: "INV-1" } : p));
  assert.deepEqual(partsToSend({ schedule: schedule(), parts: sent, today: TODAY }).map((p) => p.id), ["P2"]);
});

test("auto-pay charges parts due today or earlier, skipping held, paid and over-limit parts", () => {
  const parts = [
    part(1, 900, "2026-11-01", { status: "sent", invoiceId: "INV-1" }),
    part(2, 1200, "2026-11-03", { status: "sent", invoiceId: "INV-2" }),
    part(3, 400, "2026-11-02", { status: "on_hold", invoiceId: "INV-3" }),
    part(4, 300, "2026-11-01", { status: "paid", invoiceId: "INV-4" }),
    part(5, 200, "2026-11-04", { status: "sent", invoiceId: "INV-5" }),
  ];
  const { charge, overLimit } = partsToCharge({ schedule: schedule(), parts, today: TODAY, spendLimit: 1000 });
  assert.deepEqual(charge.map((p) => p.id), ["P1"]);
  assert.deepEqual(overLimit.map((p) => p.id), ["P2"]);
});

test("no auto-pay charges without the client's opt-in or approval, or for a milestone whose invoice isn't out", () => {
  const parts = [part(1, 900, "2026-11-01", { status: "sent", invoiceId: "INV-1" }), part(2, 100, "2026-11-01")];
  assert.deepEqual(partsToCharge({ schedule: schedule({ autopay: false }), parts, today: TODAY, spendLimit: 1000 }).charge, []);
  assert.deepEqual(partsToCharge({ schedule: schedule({ status: "proposed" }), parts, today: TODAY, spendLimit: 1000 }).charge, []);
  assert.deepEqual(partsToCharge({ schedule: schedule(), parts, today: TODAY, spendLimit: 1000 }).charge.map((p) => p.id), ["P1"]);
});

test("chunks: every part shares the schedule's one invoice, so an unsent chunk can still be charged", () => {
  const parts = [part(1, 900, "2026-11-01"), part(2, 2100, "2026-12-01")];
  const s = schedule({ mode: "chunks", invoiceId: "INV-C" });
  assert.deepEqual(partsToCharge({ schedule: s, parts, today: TODAY, spendLimit: 1000 }).charge.map((p) => p.id), ["P1"]);
});

test("nextOpenPart is the earliest part that is neither paid, cancelled nor on hold", () => {
  const parts = [part(1, 900, "2026-11-01", { status: "paid" }), part(2, 1200, "2026-11-10", { status: "on_hold" }), part(3, 900, "2026-11-20")];
  assert.equal(nextOpenPart(parts).id, "P3");
  assert.equal(nextOpenPart([part(1, 900, "2026-11-01", { status: "paid" })]), null);
});

test("allocatePaid applies money the client paid on PayPal to chunks in order, never to a held chunk", () => {
  const parts = [part(1, 900, "2026-11-01"), part(2, 1200, "2026-11-10", { status: "on_hold" }), part(3, 900, "2026-11-20")];
  assert.deepEqual(allocatePaid(parts, 900).map((p) => p.status), ["paid", "on_hold", "scheduled"]);
  assert.deepEqual(allocatePaid(parts, 1800).map((p) => p.status), ["paid", "on_hold", "paid"]);
  assert.deepEqual(allocatePaid(parts, 500).map((p) => p.status), ["scheduled", "on_hold", "scheduled"], "a part is paid only in full");
});

test("hold: 'Not done yet' affects one part only, and not a paid one", () => {
  const parts = [part(1, 900, "2026-11-01", { status: "sent" }), part(2, 1200, "2026-11-10")];
  const held = holdPart(parts[0], { note: "Design not signed off", at: TODAY });
  assert.equal(held.status, "on_hold");
  assert.equal(held.holdNote, "Design not signed off");
  assert.equal(held.statusBeforeHold, "sent");
  assert.equal(parts[1].status, "scheduled");
  assert.throws(() => holdPart(part(1, 900, "2026-11-01", { status: "paid" }), { at: TODAY }), /already paid/);
});

test("after a hold the freelancer proposes a new date; it applies only once the client approves it", () => {
  const held = holdPart(part(1, 900, "2026-11-01", { status: "sent" }), { at: TODAY });
  const proposed = proposeNewDate(held, "2026-11-15", TODAY);
  assert.equal(proposed.status, "on_hold", "still held until the client approves");
  assert.equal(proposed.dueDate, "2026-11-01");
  assert.equal(proposed.proposedDueDate, "2026-11-15");
  const approved = approveNewDate(proposed);
  assert.deepEqual([approved.status, approved.dueDate, approved.proposedDueDate], ["sent", "2026-11-15", null]);
  assert.throws(() => proposeNewDate(held, "2026-10-01", TODAY), /in the past/);
  assert.throws(() => approveNewDate(held), /no new date/);
});

test("the client can release a hold, putting the part back as it was", () => {
  const held = holdPart(part(1, 900, "2026-11-01", { status: "sent" }), { at: TODAY });
  assert.equal(releaseHold(held).status, "sent");
  assert.throws(() => releaseHold(part(1, 900, "2026-11-01")), /not on hold/);
});

import { scheduleOverrides } from "../lib/schedules.mjs";
import { toRow } from "../lib/invoices.mjs";
import { planReminders } from "../lib/reminders.mjs";

const NOW2 = new Date("2026-11-12T09:00:00Z");
const msSchedule = { id: "S1", mode: "milestones", title: "Acme site", invoiceId: null };
const chSchedule = { id: "S2", mode: "chunks", title: "Logo pack", invoiceId: "INV-C" };
const overrideParts = [
  { id: "a", scheduleId: "S1", seq: 1, amount: 900, dueDate: "2026-11-01", status: "paid", invoiceId: "INV-1" },
  { id: "b", scheduleId: "S1", seq: 2, amount: 1200, dueDate: "2026-11-05", status: "on_hold", invoiceId: "INV-2" },
  { id: "c", scheduleId: "S2", seq: 1, amount: 300, dueDate: "2026-11-01", status: "paid" },
  { id: "d", scheduleId: "S2", seq: 2, amount: 300, dueDate: "2026-11-30", status: "scheduled" },
];
const paypalInvoice = (id, status, due, value = "1200.00") => ({
  id,
  status,
  amount: { value, currency_code: "USD" },
  due_amount: { value, currency_code: "USD" },
  detail: { invoice_number: id, payment_term: { due_date: due } },
  primary_recipients: [{ billing_info: { email_address: "c@acme.com" } }],
});

test("scheduleOverrides labels each invoice with its project and marks held milestones", () => {
  const o = scheduleOverrides([msSchedule, chSchedule], overrideParts);
  assert.deepEqual(o.get("INV-2"), { project: "Acme site · 2/2", held: true, dueDate: "2026-11-05" });
  assert.deepEqual(o.get("INV-C"), { project: "Logo pack · 1/2 parts paid", held: false, dueDate: "2026-11-30" });
});

test("a held milestone is not overdue, at risk or expected on the dashboard", () => {
  const o = scheduleOverrides([msSchedule], overrideParts);
  const row = toRow(paypalInvoice("INV-2", "SENT", "2026-11-05"), NOW2, o.get("INV-2"));
  assert.equal(row.project, "Acme site · 2/2");
  assert.deepEqual([row.risk, row.days_overdue, row.overdue_amount, row.at_risk, row.expected_pay_date], ["on hold", 0, 0, 0, ""]);
  assert.equal(row.outstanding, 1200, "still owed, just not chased");
});

test("a chunked invoice follows its next part's date, not PayPal's final due date", () => {
  const o = scheduleOverrides([chSchedule], overrideParts);
  const row = toRow(paypalInvoice("INV-C", "PARTIALLY_PAID", "2026-11-30", "300.00"), new Date("2026-12-03T09:00:00Z"), o.get("INV-C"));
  assert.equal(row.due_date, "2026-11-30");
  assert.equal(row.days_overdue, 3);
});

test("reminders skip held parts and use the schedule's dates", () => {
  const o = scheduleOverrides([msSchedule, chSchedule], overrideParts);
  const invoices = [paypalInvoice("INV-2", "SENT", "2026-11-05"), paypalInvoice("INV-C", "PARTIALLY_PAID", "2026-11-01", "300.00")];
  const plans = planReminders({ invoices, existing: [], now: NOW2, overrides: o });
  assert.deepEqual(plans.map((p) => p.invoice.id), [], "held milestone skipped; chunk's next part (Nov 30) isn't due");
  const later = planReminders({ invoices, existing: [], now: new Date("2026-12-03T09:00:00Z"), overrides: o });
  assert.deepEqual(later.map((p) => [p.invoice.id, p.days]), [["INV-C", 3]]);
});

test("allocatePaid never gives a part money that already paid another part (lifted hold)", () => {
  const parts = [part(1, 300, "2026-11-01"), part(2, 300, "2026-11-10", { status: "paid" })];
  assert.deepEqual(allocatePaid(parts, 300).map((p) => p.status), ["scheduled", "paid"]);
  assert.deepEqual(allocatePaid(parts, 600).map((p) => p.status), ["paid", "paid"]);
});

test("a milestone with its own auto-pay switched off is never charged; the others still are", () => {
  const parts = [part(1, 100, "2026-11-01", { status: "sent", invoiceId: "I1", autopay: false }), part(2, 100, "2026-11-02", { status: "sent", invoiceId: "I2" })];
  assert.deepEqual(partsToCharge({ schedule: schedule(), parts, today: TODAY, spendLimit: 1000 }).charge.map((p) => p.id), ["P2"]);
});
