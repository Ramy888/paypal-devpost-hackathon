import { NextResponse } from "next/server";
import { startSubscription } from "@/lib/retainers.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { allow } from "@/lib/server/rateLimit";

// Form POST from /retainer/<id>: create the PayPal subscription and send the client to approve it.
export async function POST(req: Request) {
  const appUrl = process.env.APP_URL!;
  const publicId = String((await req.formData()).get("r") ?? "");
  if (!/^[A-Za-z0-9_-]{22}$/.test(publicId)) return NextResponse.redirect(`${appUrl}/retainer/unknown`, 303);
  const back = `${appUrl}/retainer/${publicId}`;
  if (!allow(`retainer-start:${publicId}`, 10, 60 * 60_000)) return NextResponse.redirect(`${back}?problem=1`, 303);

  const store = pgStore();
  const retainer = await store.findRetainerByPublicId(publicId);
  if (!retainer || !["offered", "pending"].includes(retainer.status)) return NextResponse.redirect(back, 303);
  try {
    const approve = await startSubscription({
      paypal: paypal(),
      store,
      retainer,
      appUrl,
      freelancerName: process.env.FREELANCER_NAME ?? "Your freelancer",
    });
    return NextResponse.redirect(approve, 303);
  } catch (err) {
    console.error(JSON.stringify({ msg: "retainer start failed", error: String(err) }));
    return NextResponse.redirect(`${back}?problem=1`, 303);
  }
}
