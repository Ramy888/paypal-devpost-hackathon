"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { proposeDateOp, markFixedOp, replyOp } from "@/lib/scheduleOps.mjs";
import { ScheduleError } from "@/lib/schedules.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { now } from "@/lib/server/clock.mjs";
import { isOwner } from "@/lib/server/owner";

// Freelancer: propose a new date for a part the client marked "Not done yet".
export async function proposeDate(partId: string, form: FormData) {
  if (!(await isOwner())) redirect("/login");
  const store = pgStore();
  const part = await store.findPart(partId);
  if (!part) redirect("/schedules");
  try {
    await proposeDateOp({ store, part, dueDate: String(form.get("dueDate") ?? ""), now: await now() });
  } catch (err) {
    if (!(err instanceof ScheduleError)) throw err;
    redirect(`/schedules?error=${encodeURIComponent(err.message)}`);
  }
  revalidatePath("/schedules");
  redirect("/schedules?done=proposed");
}

async function heldPart(partId: string) {
  if (!(await isOwner())) redirect("/login");
  const part = await pgStore().findPart(partId);
  if (!part) redirect("/schedules");
  return part;
}

async function run(fn: () => Promise<unknown>, done: string) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ScheduleError)) throw err;
    redirect(`/schedules?error=${encodeURIComponent(err.message)}`);
  }
  revalidatePath("/schedules");
  redirect(`/schedules?done=${done}`);
}

// Freelancer: what the client said was missing is fixed. The client confirms before it's due again.
export async function markFixed(partId: string, form: FormData) {
  const part = await heldPart(partId);
  await run(async () => markFixedOp({ store: pgStore(), part, note: String(form.get("note") ?? ""), now: await now() }), "fixed");
}

export async function freelancerReply(partId: string, form: FormData) {
  const part = await heldPart(partId);
  await run(async () => replyOp({ store: pgStore(), part, author: "freelancer", body: String(form.get("body") ?? ""), now: await now() }), "replied");
}
