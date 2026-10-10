import { NextResponse } from "next/server";
import { completeConnection, ConnectError } from "@/lib/connect.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { sign } from "@/lib/server/session";
import { COOKIE, cookieOptions } from "@/lib/server/connectCookies";
import { approveSchedule } from "@/lib/scheduleOps.mjs";
import { now } from "@/lib/server/clock.mjs";
import { freelancerName } from "@/lib/server/schedules";
import { serialized } from "@/lib/server/queue";

// PayPal sends the client here after approval. The approval is looked up by this
// browser's cookie, not by the query string, so it cannot be claimed elsewhere.
export async function GET(req: Request) {
  const appUrl = process.env.APP_URL!;
  const nonce = req.headers.get("cookie")?.match(new RegExp(`${COOKIE.connect}=([^;]+)`))?.[1];
  console.log(JSON.stringify({ msg: "connect return", query: new URL(req.url).search }));
  try {
    const store = pgStore();
    const { payer, agentKey, pending } = await completeConnection({ paypal: paypal(), store, nonce });
    // Started from a payment schedule: this approval turns on its auto-pay.
    const schedule = pending.scheduleId ? await store.findSchedule(pending.scheduleId) : null;
    let next = `${appUrl}/connect/done`;
    if (schedule) {
      next = `${appUrl}/pay/${schedule.publicId}?done=autopay-on`;
      try {
        if (schedule.status === "proposed") {
          const parts = await store.listParts(schedule.id);
          await approveSchedule({ store, paypal: paypal(), schedule, parts, autopay: true, payerId: payer.id, freelancerName: freelancerName(), appUrl, now: await now(), serialize: serialized });
        } else {
          await store.setScheduleAutopay(schedule.id, true, payer.id);
        }
      } catch (err) {
        // PayPal approved; only our side failed. Show the schedule with what actually got saved.
        console.error(JSON.stringify({ msg: "autopay approval save failed", schedule_id: schedule.id, error: String(err) }));
        next = `${appUrl}/pay/${schedule.publicId}?problem=paypal`;
      }
    }
    const res = NextResponse.redirect(next, 303);
    if (agentKey) res.cookies.set(COOKIE.reveal, agentKey, cookieOptions(10 * 60));
    res.cookies.set(COOKIE.payer, sign(payer.id), cookieOptions(30 * 24 * 60 * 60));
    res.cookies.delete({ name: COOKIE.connect, path: "/connect" });
    return res;
  } catch (err) {
    const reason = err instanceof ConnectError ? err.code : "PAYPAL_UNAVAILABLE";
    if (!(err instanceof ConnectError)) console.error(JSON.stringify({ msg: "connect return failed", error: String(err) }));
    return NextResponse.redirect(`${appUrl}/connect/problem?reason=${reason}`, 303);
  }
}
