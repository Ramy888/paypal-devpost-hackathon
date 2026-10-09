// The demo clock: real time plus an offset in days that the freelancer can jump forward.
// Stored in Postgres so every request and the autopilot agree on "now".
import { pgStore } from "./db.mjs";

const KEY = "clock_offset_days";
const DAY_MS = 86_400_000;

export async function clockOffsetDays() {
  if (!process.env.DATABASE_URL) return 0;
  return Number((await pgStore().getSetting(KEY)) ?? 0) || 0;
}

export async function now() {
  return new Date(Date.now() + (await clockOffsetDays()) * DAY_MS);
}

export async function setClockOffsetDays(days) {
  await pgStore().setSetting(KEY, Math.max(0, Math.min(365, Math.trunc(days))));
}

// A window ending at the demo clock's "today" and starting `days` before real time,
// so jumping the clock forward never hides payments that really happened this week.
export async function recentWindow(days = 7) {
  const to = await now();
  return { from: new Date(Math.min(Date.now(), to.getTime()) - days * DAY_MS), to };
}
