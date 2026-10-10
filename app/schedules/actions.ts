"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { proposeDateOp } from "@/lib/scheduleOps.mjs";
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
