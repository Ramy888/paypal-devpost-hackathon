import { applySubscriptionEvent, subscriptionEvent } from "@/lib/retainers.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";

/** Applies a verified subscription webhook. Returns false when the event isn't about a retainer. */
export async function applyRetainerWebhook(event: unknown): Promise<boolean> {
  const ev = subscriptionEvent(event);
  if (!ev) return false;
  const store = pgStore();
  const row = await store.findRetainerBySubscription(ev.subscriptionId);
  if (!row) return false; // a sale for something else, e.g. an ordinary invoice
  // The client approved after the freelancer withdrew the offer: stop it before it bills again.
  if (row.status === "cancelled" && ev.status === "active") {
    await paypal().request("POST", `/v1/billing/subscriptions/${encodeURIComponent(ev.subscriptionId)}/cancel`, { reason: "Offer was withdrawn" });
    return true;
  }
  const patch = applySubscriptionEvent(row, ev);
  if (patch) await store.updateRetainer(row.id, patch);
  return true;
}
