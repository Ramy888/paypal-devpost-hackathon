// Payment schedule operations: approve, send milestone invoices, auto-pay due parts, holds and
// new dates, and matching PayPal payments back to parts. I/O comes in as arguments.
import { isEmail } from "./email.mjs";
import {
  validateSchedule,
  partsToSend,
  partsToCharge,
  allocatePaid,
  holdPart,
  proposeNewDate,
  approveNewDate,
  releaseHold,
  markFixed,
  stillNotDone,
  ScheduleError,
  scheduleOverrides,
} from "./schedules.mjs";
import { amountToCharge, chargeInvoice, AgentPayError, AUTOPAY_NOTE_PREFIX } from "./agentPay.mjs";
import { isPaid, SCHEDULE_EVENT } from "./invoices.mjs";

const day = (d) => new Date(d).toISOString().slice(0, 10);
const money2 = (n) => Number(n).toFixed(2);
const PAYABLE = ["SENT", "UNPAID", "PARTIALLY_PAID"];
// Written into the PayPal payment note so a charge can always be matched to its part.
const partMarker = (p) => `schedule part ${p.id}`;

export const scheduleLink = (appUrl, schedule) => `${appUrl}/pay/${schedule.publicId}`;

/** Freelancer creates a schedule. Nothing goes to PayPal until the client approves it. */
export async function createSchedule({ store, input, publicId, now = new Date() }) {
  const parts = input.parts.map((p, i) => ({ seq: i + 1, name: String(p.name ?? "").trim() || `Part ${i + 1}`, amount: Number(p.amount), dueDate: p.dueDate }));
  const total = Math.round(parts.reduce((t, p) => t + p.amount * 100, 0)) / 100;
  validateSchedule({ mode: input.mode, total, parts }, now);
  if (!isEmail(input.clientEmail?.trim())) throw new ScheduleError("Add the client's email.");
  return store.insertSchedule({
    publicId,
    mode: input.mode,
    title: String(input.title ?? "").trim().slice(0, 120) || "Project",
    clientEmail: input.clientEmail.trim().toLowerCase(),
    clientName: String(input.clientName ?? "").trim(),
    currency: input.currency || "USD",
    total,
    parts,
  });
}

/** PayPal invoice body for one milestone, or for the single chunked invoice. */
export function scheduleInvoiceBody({ schedule, parts, part, freelancerName, invoiceNumber, appUrl }) {
  const link = scheduleLink(appUrl, schedule);
  const recipient = { billing_info: { email_address: schedule.clientEmail, ...(schedule.clientName ? { business_name: schedule.clientName } : {}) } };
  const item = (name, amount) => ({ name: name.slice(0, 200), quantity: "1", unit_amount: { currency_code: schedule.currency, value: money2(amount) } });
  if (part) {
    return {
      detail: {
        invoice_number: invoiceNumber,
        currency_code: schedule.currency,
        note: `Milestone ${part.seq} of ${parts.length} for ${schedule.title}: ${part.name}.`,
        terms_and_conditions: `Your payment schedule, with a "Not done yet" button for each milestone: ${link}`,
        payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: part.dueDate },
      },
      invoicer: { business_name: freelancerName },
      primary_recipients: [recipient],
      items: [item(`${schedule.title}: ${part.name}`, part.amount)],
    };
  }
  const smallest = Math.min(...parts.map((p) => p.amount));
  const plan = parts.map((p) => `${p.name} ${money2(p.amount)} on ${p.dueDate}`).join("; ");
  return {
    detail: {
      invoice_number: invoiceNumber,
      currency_code: schedule.currency,
      note: `${schedule.title}, paid in ${parts.length} parts: ${plan}.`.slice(0, 4000),
      terms_and_conditions: `Your payment schedule, with a "Not done yet" button for each part: ${link}`,
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: parts.at(-1).dueDate },
    },
    invoicer: { business_name: freelancerName },
    primary_recipients: [recipient],
    items: [item(schedule.title, schedule.total)],
    configuration: {
      partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: schedule.currency, value: money2(smallest) } },
    },
  };
}

const invoiceNumberFor = (schedule, part) => `CP-${schedule.publicId.replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}-${part ? `M${part.seq}` : "C"}`;

/**
 * Chunks: create and send the one invoice once the schedule is approved. Safe to call again:
 * an invoice created earlier is reused, and sent if that send failed (it is still a draft).
 */
export async function ensureChunkInvoice({ store, paypal, schedule, parts, freelancerName, appUrl }) {
  if (schedule.mode !== "chunks" || schedule.status !== "approved") return schedule.invoiceId ?? null;
  let invoiceId = schedule.invoiceId;
  if (invoiceId) {
    const inv = await paypal.request("GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
    if (inv.status !== "DRAFT") return invoiceId;
  } else {
    const created = await paypal.request(
      "POST",
      "/v2/invoicing/invoices",
      scheduleInvoiceBody({ schedule, parts, freelancerName, invoiceNumber: invoiceNumberFor(schedule), appUrl }),
    );
    invoiceId = created.id;
    // Saved before sending, so a failed send is retried on this invoice instead of creating another.
    await store.setScheduleInvoice(schedule.id, invoiceId);
  }
  await paypal.request("POST", `/v2/invoicing/invoices/${invoiceId}/send`, { send_to_recipient: true });
  return invoiceId;
}

/**
 * Client approves the whole schedule, optionally with auto-pay from their saved PayPal approval.
 * `serialize` runs the chunk invoice creation in the same queue as the agent pass, so the two
 * can never both create an invoice for one schedule.
 */
export async function approveSchedule({ store, paypal, schedule, parts, autopay = false, payerId = null, freelancerName, appUrl, now = new Date(), serialize = (job) => job() }) {
  if (schedule.status !== "proposed") throw new ScheduleError("This schedule was already approved.");
  if (autopay && !payerId) throw new ScheduleError("Auto-pay needs your PayPal approval first.");
  const approved = await store.approveSchedule(schedule.id, { autopay, payerId, now });
  if (!approved) throw new ScheduleError("This schedule was already approved.");
  // The approval stands even if PayPal is down; the next agent pass creates or sends the invoice.
  try {
    await serialize(async () => {
      // Re-read inside the queue: an agent pass may have created the invoice meanwhile.
      const current = (await store.findSchedule?.(approved.id)) ?? approved;
      await ensureChunkInvoice({ store, paypal, schedule: current, parts, freelancerName, appUrl });
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: "chunk invoice deferred", schedule_id: approved.id, error: String(err) }));
  }
  return approved;
}

/** Milestones: create and send each invoice a few days before its due date. */
export async function sendDueMilestones({ store, paypal, schedule, parts, today, freelancerName, appUrl }) {
  const sent = [];
  for (const part of partsToSend({ schedule, parts, today })) {
    let invoiceId = part.invoiceId;
    if (!invoiceId) {
      const created = await paypal.request(
        "POST",
        "/v2/invoicing/invoices",
        scheduleInvoiceBody({ schedule, parts, part, freelancerName, invoiceNumber: invoiceNumberFor(schedule, part), appUrl }),
      );
      invoiceId = created.id;
      // Saved before sending, so a crash here never creates a second invoice for this part.
      await store.updatePart(part.id, { invoiceId });
    }
    await paypal.request("POST", `/v2/invoicing/invoices/${invoiceId}/send`, { send_to_recipient: true });
    await store.updatePart(part.id, { status: "sent" });
    sent.push({ partId: part.id, invoiceId });
  }
  return sent;
}

/**
 * Auto-pay: charges each due part once per due date, with the client's saved PayPal approval,
 * and records every attempt. A failure is recorded and shown, never retried blindly.
 */
export async function chargeDueParts({ store, paypal, orders, schedule, parts, payer, today, eventStore }) {
  if (!payer || payer.status !== "active") return [];
  const { charge, overLimit } = partsToCharge({ schedule, parts, today, spendLimit: payer.spendLimit });
  if (!charge.length && !overLimit.length) return [];
  const history = await store.listCharges([...charge, ...overLimit].map((p) => p.id));
  const triedForDate = (p) => history.some((c) => c.partId === p.id && (c.outcome === "captured" || day(c.attemptedAt) >= p.dueDate));
  const results = [];

  for (const p of overLimit.filter((x) => !triedForDate(x))) {
    await store.insertCharge({ partId: p.id, amount: p.amount, outcome: "over_limit", detail: `Over the auto-pay limit of ${payer.spendLimit}.`, attemptedAt: today });
    results.push({ partId: p.id, outcome: "over_limit" });
  }

  for (const p of charge.filter((x) => !triedForDate(x))) {
    const invoiceId = schedule.mode === "chunks" ? schedule.invoiceId : p.invoiceId;
    const marker = partMarker(p);
    const inv = await paypal.request("GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
    // Already paid: an earlier pass charged it (its note carries this part's marker) but didn't
    // finish saving, or the client paid the milestone invoice by hand. Never charge again.
    const earlier = (inv.payments?.transactions ?? []).find((t) => (t.note ?? "").includes(marker));
    if (earlier || (schedule.mode === "milestones" && isPaid(inv.status))) {
      await store.updatePart(p.id, { status: "paid", paidAt: today });
      results.push({ partId: p.id, outcome: "already_paid" });
      continue;
    }
    let outcome;
    try {
      if (!PAYABLE.includes(inv.status)) throw new AgentPayError("NOT_PAYABLE", `Invoice is ${inv.status}.`);
      const value = amountToCharge(inv, schedule.mode === "chunks" ? p.amount : undefined);
      const paid = await chargeInvoice({ paypal, orders, inv, vaultId: payer.vaultId, value, notePrefix: AUTOPAY_NOTE_PREFIX, noteSuffix: ` · ${marker}`, eventStore, now: today });
      // The audit row goes first: if saving the part fails, the next pass still won't charge again.
      await store.insertCharge({ partId: p.id, amount: Number(value), outcome: "captured", captureId: paid.paypal_capture_id, attemptedAt: today });
      await store.updatePart(p.id, { status: "paid", paidAt: today, captureId: paid.paypal_capture_id });
      await store.recordPayment(payer.id, Number(value));
      outcome = "captured";
    } catch (err) {
      if (!(err instanceof AgentPayError)) throw err;
      outcome = err.code === "PAYMENT_UNCONFIRMED" || err.code === "PAYMENT_PENDING" ? "unconfirmed" : "failed";
      await store.insertCharge({ partId: p.id, amount: p.amount, outcome, detail: err.message, attemptedAt: today });
    }
    results.push({ partId: p.id, outcome });
  }
  return results;
}

/** A verified invoice webhook: marks milestone parts paid, and spreads chunk payments over parts. */
export async function reconcileInvoice({ store, paypal, invoiceId, now = new Date() }) {
  const part = await store.findPartByInvoice(invoiceId);
  if (part) {
    const inv = await paypal.request("GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
    if (isPaid(inv.status) && part.status !== "paid") await store.updatePart(part.id, { status: "paid", paidAt: now });
    return true;
  }
  const schedule = await store.findScheduleByInvoice(invoiceId);
  if (!schedule) return false;
  const inv = await paypal.request("GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
  const paidTotal = Number(inv.payments?.paid_amount?.value ?? 0);
  const before = await store.listParts(schedule.id);
  const after = allocatePaid(before, paidTotal);
  for (const p of after) {
    if (p.status === "paid" && before.find((b) => b.id === p.id).status !== "paid") await store.updatePart(p.id, { status: "paid", paidAt: now });
  }
  return true;
}

const savePart = (store, p) =>
  store.updatePart(p.id, {
    status: p.status,
    statusBeforeHold: p.statusBeforeHold ?? null,
    holdNote: p.holdNote ?? "",
    heldAt: p.heldAt ?? null,
    dueDate: p.dueDate,
    proposedDueDate: p.proposedDueDate ?? null,
    fixedAt: p.fixedAt ?? null,
  });

// Every step of a "Not done yet" conversation is kept as a thread message on the part.
const say = (store, part, author, kind, body, now) =>
  store.insertMessage({ partId: part.id, author, kind, body: String(body ?? "").trim().slice(0, 1000), createdAt: now });

/**
 * Tells open dashboards that a part's hold changed, so its invoice row shows "On hold" (or stops)
 * at once. Best effort: a failure here never undoes or fails the change itself.
 */
async function announce(store, eventStore, part, change, now) {
  if (!eventStore) return;
  try {
    const schedule = await store.findSchedule(part.scheduleId);
    const parts = await store.listParts(part.scheduleId);
    const invoiceId = schedule.mode === "milestones" ? parts.find((p) => p.id === part.id)?.invoiceId : schedule.invoiceId;
    if (!invoiceId) return;
    const o = scheduleOverrides([schedule], parts).get(invoiceId);
    eventStore.add({
      id: `SCHED-${part.id}-${change}-${now.getTime()}`,
      event_type: SCHEDULE_EVENT,
      invoice_id: invoiceId,
      held: Boolean(o?.held),
      change,
      part_name: part.name,
      project: o?.project ?? schedule.title,
      received_at: now.toISOString(),
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: "hold announce failed", part_id: part.id, error: String(err) }));
  }
}

/** Client: "Not done yet" on one part, saying what is missing. */
export async function holdPartOp({ store, part, note, now = new Date(), eventStore }) {
  const next = holdPart(part, { note, at: now });
  await savePart(store, next);
  await say(store, part, "client", "hold", note, now);
  await announce(store, eventStore, next, "hold", now);
  return next;
}

/** Client: lift a hold without waiting for the freelancer. */
export async function releaseHoldOp({ store, part, now = new Date(), eventStore }) {
  const next = releaseHold(part);
  await savePart(store, next);
  await say(store, part, "client", "released", "", now);
  await announce(store, eventStore, next, "released", now);
  return next;
}

/** Freelancer: propose a new due date for a held part. */
export async function proposeDateOp({ store, part, dueDate, now = new Date(), eventStore }) {
  const next = proposeNewDate(part, dueDate, now);
  await savePart(store, next);
  await say(store, part, "freelancer", "date_proposed", dueDate, now);
  await announce(store, eventStore, next, "date_proposed", now);
  return next;
}

/** Either side: a plain reply in the part's thread. */
export async function replyOp({ store, part, author, body, now = new Date() }) {
  if (!String(body ?? "").trim()) throw new ScheduleError("Write a message first.");
  await say(store, part, author, "reply", body, now);
  return part;
}

/** Freelancer: what was missing is fixed. The client still confirms before the part is due again. */
export async function markFixedOp({ store, part, note, now = new Date(), eventStore }) {
  const next = markFixed(part, now);
  await savePart(store, next);
  await say(store, part, "freelancer", "fixed", note, now);
  await announce(store, eventStore, next, "fixed", now);
  return next;
}

/** Client: confirms the fix; the hold lifts and the part is due on its date again. */
export async function confirmFixedOp({ store, part, now = new Date(), eventStore }) {
  const next = releaseHold(part);
  await savePart(store, next);
  await say(store, part, "client", "confirmed", "", now);
  await announce(store, eventStore, next, "confirmed", now);
  return next;
}

/** Client: the fix isn't there yet; the hold stays. */
export async function stillNotDoneOp({ store, part, note, now = new Date(), eventStore }) {
  const next = stillNotDone(part);
  await savePart(store, next);
  await say(store, part, "client", "still_not_done", note, now);
  await announce(store, eventStore, next, "still_not_done", now);
  return next;
}

/** Client: auto-pay on or off for one part (the schedule's PayPal approval covers the rest). */
export async function setPartAutopayOp({ store, part, autopay }) {
  await store.updatePart(part.id, { autopay: Boolean(autopay) });
  return { ...part, autopay: Boolean(autopay) };
}

/**
 * Client: approve the new date. A milestone invoice already sent gets the new due date on PayPal
 * too (best effort: the schedule's own date is what auto-pay and reminders follow).
 */
export async function approveDateOp({ store, paypal, part, now = new Date(), eventStore }) {
  const next = approveNewDate(part);
  await savePart(store, next);
  await say(store, part, "client", "date_approved", next.dueDate, now);
  await announce(store, eventStore, next, "date_approved", now);
  if (next.invoiceId) {
    try {
      const inv = await paypal.request("GET", `/v2/invoicing/invoices/${encodeURIComponent(next.invoiceId)}`);
      inv.detail.payment_term = { ...inv.detail.payment_term, due_date: next.dueDate };
      await paypal.request("PUT", `/v2/invoicing/invoices/${encodeURIComponent(next.invoiceId)}?send_to_recipient=false`, inv);
    } catch (err) {
      console.error(JSON.stringify({ msg: "invoice due date update failed", invoice_id: next.invoiceId, error: String(err) }));
    }
  }
  return next;
}

/** The client's schedules and milestones, in the shape the client's agents read (assistant and /mcp). */
export async function schedulesOwed({ store, payer }) {
  const schedules = await store.listSchedulesForPayer({ payerId: payer.id, email: payer.email });
  const out = [];
  for (const s of schedules) {
    const parts = await store.listParts(s.id);
    out.push({
      title: s.title,
      auto_pay: s.autopay,
      milestones: parts.map((p) => ({
        part_id: p.id,
        name: p.name,
        amount: p.amount,
        currency: s.currency,
        due_date: p.dueDate,
        status: p.status === "on_hold" ? "not done yet (on hold)" : p.status,
        auto_pay: s.autopay && p.autopay !== false,
      })),
    });
  }
  return out;
}
