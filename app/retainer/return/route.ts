import { NextResponse } from "next/server";
import { applySubscriptionEvent, verifyReturn } from "@/lib/retainers.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { notifyRetainerChange } from "@/lib/events.mjs";

// PayPal sends the client back here after approval. The query is only a hint: we re-read the
// subscription we created and check it before marking the retainer active.
export async function GET(req: Request) {
  const appUrl = process.env.APP_URL!;
  const url = new URL(req.url);
  const publicId = url.searchParams.get("r") ?? "";
  const store = pgStore();
  const retainer = /^[A-Za-z0-9_-]{22}$/.test(publicId) ? await store.findRetainerByPublicId(publicId) : null;
  if (!retainer?.subscriptionId) return NextResponse.redirect(`${appUrl}/retainer/${publicId}`, 303);

  const back = `${appUrl}/retainer/${publicId}`;
  try {
    const subscription = await paypal().request("GET", `/v1/billing/subscriptions/${encodeURIComponent(retainer.subscriptionId)}`);
    const check = verifyReturn({ retainer, subscription });
    if (check.ok && url.searchParams.get("subscription_id") === retainer.subscriptionId) {
      if (retainer.status === "cancelled") {
        // Approved after the offer was withdrawn: undo it straight away.
        await paypal().request("POST", `/v1/billing/subscriptions/${encodeURIComponent(subscription.id)}/cancel`, { reason: "Offer was withdrawn" });
        return NextResponse.redirect(back, 303);
      }
      const patch = applySubscriptionEvent(retainer, { status: "active" });
      if (patch) await store.updateRetainer(retainer.id, patch);
      notifyRetainerChange();
      return NextResponse.redirect(`${back}/done`, 303);
    }
    // APPROVED but not yet ACTIVE: PayPal is still finishing; the webhook will flip it.
    if (check.reason === "NOT_ACTIVE" && check.status === "APPROVED") {
      notifyRetainerChange();
      return NextResponse.redirect(`${back}/done`, 303);
    }
    return NextResponse.redirect(`${back}?problem=1`, 303);
  } catch (err) {
    console.error(JSON.stringify({ msg: "retainer return failed", error: String(err) }));
    return NextResponse.redirect(`${back}?problem=1`, 303);
  }
}
