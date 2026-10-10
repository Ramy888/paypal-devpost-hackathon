import { randomBytes } from "node:crypto";
import { createSchedule, scheduleLink } from "@/lib/scheduleOps.mjs";
import { ScheduleError } from "@/lib/schedules.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { now } from "@/lib/server/clock.mjs";
import { isOwner } from "@/lib/server/owner";

// Creates a payment schedule (milestones or chunks) for the client to approve. Nothing goes to PayPal yet.
export async function POST(req: Request) {
  if (!(await isOwner())) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Send the schedule as JSON." }, { status: 400 });
  try {
    // 128 random bits: the client's schedule page is public, so its address must not be guessable.
    const publicId = randomBytes(16).toString("base64url");
    const schedule = await createSchedule({
      store: pgStore(),
      input: {
        mode: body.mode,
        title: body.title,
        clientEmail: body.client_email,
        clientName: body.client_name,
        currency: body.currency,
        parts: Array.isArray(body.parts) ? body.parts.map((p: { name: string; amount: number; due_date: string }) => ({ name: p.name, amount: p.amount, dueDate: p.due_date })) : [],
      },
      publicId,
      now: await now(),
    });
    return Response.json({ id: schedule.id, link: scheduleLink(process.env.APP_URL!, schedule), total: schedule.total, currency: schedule.currency });
  } catch (err) {
    if (err instanceof ScheduleError) return Response.json({ error: err.message }, { status: 400 });
    console.error(JSON.stringify({ msg: "schedule create failed", error: String(err) }));
    return Response.json({ error: "Couldn't save the schedule. Try again in a minute." }, { status: 500 });
  }
}
