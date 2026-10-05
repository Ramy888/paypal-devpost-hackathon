"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sendReminder } from "@/lib/reminders.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { clockOffsetDays, now, setClockOffsetDays } from "@/lib/server/clock.mjs";
import { runTick } from "@/lib/server/agent";
import { paypal } from "@/lib/server/paypal";
import { isOwner } from "@/lib/server/owner";

async function requireOwner() {
  if (!(await isOwner())) redirect("/login");
}

// Demo clock: move "today" forward, then let the agent look at the new date.
export async function jumpClock(days: number) {
  await requireOwner();
  await setClockOffsetDays((await clockOffsetDays()) + days);
  await runTick({ draft: true });
  revalidatePath("/reminders");
  revalidatePath("/");
}

export async function resetClock() {
  await requireOwner();
  await setClockOffsetDays(0);
  revalidatePath("/reminders");
  revalidatePath("/");
}

export async function checkNow() {
  await requireOwner();
  await runTick({ draft: true });
  revalidatePath("/reminders");
}

export async function approveAndSend(id: string) {
  await requireOwner();
  const store = pgStore();
  const reminder = await store.findReminder(id);
  if (reminder) await sendReminder({ paypal: paypal(), store, reminder, by: "you", now: await now() });
  revalidatePath("/reminders");
}

export async function saveEdits(id: string, form: FormData) {
  await requireOwner();
  const subject = String(form.get("subject") ?? "").trim().slice(0, 120);
  const body = String(form.get("body") ?? "").trim().slice(0, 900);
  if (subject && body) await pgStore().updateReminderText(id, subject, body);
  revalidatePath("/reminders");
}

export async function cancelReminder(id: string) {
  await requireOwner();
  await pgStore().cancelReminder(id, "cancelled by you");
  revalidatePath("/reminders");
}
