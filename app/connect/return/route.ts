import { NextResponse } from "next/server";
import { completeConnection, ConnectError } from "@/lib/connect.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { sign } from "@/lib/server/session";
import { COOKIE, cookieOptions } from "@/lib/server/connectCookies";

// PayPal sends the client here after approval. The approval is looked up by this
// browser's cookie, not by the query string, so it cannot be claimed elsewhere.
export async function GET(req: Request) {
  const appUrl = process.env.APP_URL!;
  const nonce = req.headers.get("cookie")?.match(new RegExp(`${COOKIE.connect}=([^;]+)`))?.[1];
  console.log(JSON.stringify({ msg: "connect return", query: new URL(req.url).search }));
  try {
    const { payer, agentKey } = await completeConnection({ paypal: paypal(), store: pgStore(), nonce });
    const res = NextResponse.redirect(`${appUrl}/connect/done`, 303);
    res.cookies.set(COOKIE.reveal, agentKey, cookieOptions(10 * 60));
    res.cookies.set(COOKIE.payer, sign(payer.id), cookieOptions(30 * 24 * 60 * 60));
    res.cookies.delete({ name: COOKIE.connect, path: "/connect" });
    return res;
  } catch (err) {
    const reason = err instanceof ConnectError ? err.code : "PAYPAL_UNAVAILABLE";
    if (!(err instanceof ConnectError)) console.error(JSON.stringify({ msg: "connect return failed", error: String(err) }));
    return NextResponse.redirect(`${appUrl}/connect/problem?reason=${reason}`, 303);
  }
}
