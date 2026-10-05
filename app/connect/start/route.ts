import { NextResponse } from "next/server";
import { startConnection, ConnectError } from "@/lib/connect.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { COOKIE, cookieOptions } from "@/lib/server/connectCookies";

// Form POST from /connect: create the PayPal approval and send the client there.
export async function POST(req: Request) {
  const appUrl = process.env.APP_URL!;
  const form = await req.formData();
  const invoiceId = String(form.get("invoice") ?? "");
  const spendLimit = Number(form.get("limit"));
  try {
    const { approveUrl, nonce } = await startConnection({ paypal: paypal(), store: pgStore(), appUrl, invoiceId, spendLimit });
    const res = NextResponse.redirect(approveUrl, 303);
    res.cookies.set(COOKIE.connect, nonce, cookieOptions(60 * 60));
    return res;
  } catch (err) {
    const reason = err instanceof ConnectError ? err.code : "PAYPAL_UNAVAILABLE";
    if (!(err instanceof ConnectError)) console.error(JSON.stringify({ msg: "connect start failed", error: String(err) }));
    return NextResponse.redirect(`${appUrl}/connect/problem?reason=${reason}`, 303);
  }
}
