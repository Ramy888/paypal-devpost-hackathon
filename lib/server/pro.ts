import { applyProEvent, isPro, proState } from "@/lib/proPlan.mjs";
import { subscriptionEvent } from "@/lib/retainers.mjs";
import { pgStore } from "@/lib/server/db.mjs";

export async function ownerIsPro() {
  return isPro(await proState(pgStore()));
}

/** Applies a verified subscription webhook about the Pro plan. False when it's about something else. */
export async function applyProWebhook(event: unknown): Promise<boolean> {
  return applyProEvent({ store: pgStore(), ev: subscriptionEvent(event) });
}
