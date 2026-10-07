import { NextResponse } from "next/server";
import { confirmPro } from "@/lib/proPlan.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { isOwner } from "@/lib/server/owner";

// PayPal sends the freelancer back here after approving Pro.
export async function GET(req: Request) {
  const appUrl = process.env.APP_URL!;
  if (!(await isOwner())) return NextResponse.redirect(`${appUrl}/login`, 303);
  const returnedId = new URL(req.url).searchParams.get("subscription_id");
  try {
    const check = await confirmPro({ paypal: paypal(), store: pgStore(), returnedId });
    if (check.ok || ("status" in check && check.status === "APPROVED")) return NextResponse.redirect(`${appUrl}/billing?upgraded=1`, 303);
  } catch (err) {
    console.error(JSON.stringify({ msg: "pro return failed", error: String(err) }));
  }
  return NextResponse.redirect(`${appUrl}/billing?problem=1`, 303);
}
