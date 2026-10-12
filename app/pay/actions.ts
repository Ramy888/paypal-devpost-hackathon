"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { approveSchedule, holdPartOp, releaseHoldOp, approveDateOp, confirmFixedOp, stillNotDoneOp, replyOp, setPartAutopayOp } from "@/lib/scheduleOps.mjs";
import { ScheduleError } from "@/lib/schedules.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { eventStore } from "@/lib/events.mjs";
import { paypal } from "@/lib/server/paypal";
import { now } from "@/lib/server/clock.mjs";
import { allow } from "@/lib/server/rateLimit";
import { freelancerName, loadByPublicId } from "@/lib/server/schedules";
import { serialized } from "@/lib/server/queue";

// The client's actions on their schedule page. The page is public: its unguessable link is the
// client's access, the same way retainer offer links work.

async function load(publicId: string) {
  if (!allow(`pay:${publicId}`, 30, 60 * 60_000)) redirect(`/pay/${publicId}?problem=busy`);
  const found = await loadByPublicId(publicId);
  if (!found) redirect("/pay/unknown");
  return found;
}

function partOf(found: NonNullable<Awaited<ReturnType<typeof loadByPublicId>>>, partId: string) {
  return found.parts.find((p: { id: string }) => p.id === partId) ?? null;
}

async function run(publicId: string, fn: () => Promise<unknown>, done: string) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ScheduleError)) {
      console.error(JSON.stringify({ msg: "schedule action failed", error: String(err) }));
      redirect(`/pay/${publicId}?problem=paypal`);
    }
    redirect(`/pay/${publicId}?error=${encodeURIComponent(err.message)}`);
  }
  revalidatePath(`/pay/${publicId}`);
  redirect(`/pay/${publicId}?done=${done}`);
}

export async function approveWithoutAutopay(publicId: string) {
  const found = await load(publicId);
  await run(
    publicId,
    async () =>
      approveSchedule({
        store: pgStore(),
        paypal: paypal(),
        schedule: found.schedule,
        parts: found.parts,
        autopay: false,
        freelancerName: freelancerName(),
        appUrl: process.env.APP_URL!,
        now: await now(),
        serialize: serialized,
      }),
    "approved",
  );
}

export async function holdPart(publicId: string, partId: string, form: FormData) {
  const found = await load(publicId);
  const part = partOf(found, partId);
  if (!part) redirect(`/pay/${publicId}`);
  await run(publicId, async () => holdPartOp({ store: pgStore(), part, note: String(form.get("note") ?? ""), now: await now(), eventStore }), "held");
}

export async function releaseHold(publicId: string, partId: string) {
  const found = await load(publicId);
  const part = partOf(found, partId);
  if (!part) redirect(`/pay/${publicId}`);
  await run(publicId, async () => releaseHoldOp({ store: pgStore(), part, now: await now(), eventStore }), "released");
}

export async function approveNewDate(publicId: string, partId: string) {
  const found = await load(publicId);
  const part = partOf(found, partId);
  if (!part) redirect(`/pay/${publicId}`);
  await run(publicId, async () => approveDateOp({ store: pgStore(), paypal: paypal(), part, now: await now(), eventStore }), "date");
}

export async function turnOffAutopay(publicId: string) {
  const found = await load(publicId);
  await run(publicId, () => pgStore().setScheduleAutopay(found.schedule.id, false), "autopay-off");
}

export async function confirmFixed(publicId: string, partId: string) {
  const found = await load(publicId);
  const part = partOf(found, partId);
  if (!part) redirect(`/pay/${publicId}`);
  await run(publicId, async () => confirmFixedOp({ store: pgStore(), part, now: await now(), eventStore }), "confirmed");
}

export async function stillNotDone(publicId: string, partId: string, form: FormData) {
  const found = await load(publicId);
  const part = partOf(found, partId);
  if (!part) redirect(`/pay/${publicId}`);
  await run(publicId, async () => stillNotDoneOp({ store: pgStore(), part, note: String(form.get("note") ?? ""), now: await now(), eventStore }), "still");
}

export async function clientReply(publicId: string, partId: string, form: FormData) {
  const found = await load(publicId);
  const part = partOf(found, partId);
  if (!part) redirect(`/pay/${publicId}`);
  await run(publicId, async () => replyOp({ store: pgStore(), part, author: "client", body: String(form.get("body") ?? ""), now: await now() }), "replied");
}

// One milestone's auto-pay switch. Only works once the schedule has the client's PayPal approval;
// before that the switch posts to /pay/start instead.
export async function setPartAutopay(publicId: string, partId: string, autopay: boolean) {
  const found = await load(publicId);
  const part = partOf(found, partId);
  if (!part || !found.schedule.autopay) redirect(`/pay/${publicId}`);
  await run(publicId, () => setPartAutopayOp({ store: pgStore(), part, autopay }), autopay ? "part-on" : "part-off");
}
