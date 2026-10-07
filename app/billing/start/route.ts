import { NextResponse } from "next/server";
import { startPro } from "@/lib/proPlan.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { isOwner } from "@/lib/server/owner";

// Form POST from /billing: create the Pro subscription and send the freelancer to PayPal to approve it.
export async function POST() {
  const appUrl = process.env.APP_URL!;
  if (!(await isOwner())) return NextResponse.redirect(`${appUrl}/login`, 303);
  try {
    return NextResponse.redirect(await startPro({ paypal: paypal(), store: pgStore(), appUrl }), 303);
  } catch (err) {
    console.error(JSON.stringify({ msg: "pro start failed", error: String(err) }));
    return NextResponse.redirect(`${appUrl}/billing?problem=1`, 303);
  }
}
