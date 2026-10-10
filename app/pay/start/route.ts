import { NextResponse } from "next/server";
import { startConnection, ConnectError } from "@/lib/connect.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { allow } from "@/lib/server/rateLimit";
import { COOKIE, cookieOptions } from "@/lib/server/connectCookies";
import { isPublicId } from "@/lib/server/schedules";

// Form POST from /pay/<id>: "Approve and turn on auto-pay". The client approves CollectPilot
// once on PayPal, with a per-charge limit of the schedule's largest part.
export async function POST(req: Request) {
  const appUrl = process.env.APP_URL!;
  const publicId = String((await req.formData()).get("s") ?? "");
  if (!isPublicId(publicId)) return NextResponse.redirect(`${appUrl}/pay/unknown`, 303);
  const back = `${appUrl}/pay/${publicId}`;
  if (!allow(`pay-start:${publicId}`, 10, 60 * 60_000)) return NextResponse.redirect(`${back}?problem=busy`, 303);

  const store = pgStore();
  const schedule = await store.findScheduleByPublicId(publicId);
  if (!schedule || schedule.status === "cancelled") return NextResponse.redirect(back, 303);
  const parts: { amount: number; status: string }[] = await store.listParts(schedule.id);
  const open = parts.filter((p) => p.status !== "paid" && p.status !== "cancelled");
  if (!open.length) return NextResponse.redirect(back, 303);
  const spendLimit = Math.max(...open.map((p) => p.amount));
  try {
    const { approveUrl, nonce } = await startConnection({
      paypal: paypal(),
      store,
      appUrl,
      invoiceId: "",
      spendLimit,
      schedule: { id: schedule.id, title: schedule.title },
    });
    const res = NextResponse.redirect(approveUrl, 303);
    res.cookies.set(COOKIE.connect, nonce, cookieOptions(60 * 60));
    return res;
  } catch (err) {
    if (!(err instanceof ConnectError)) console.error(JSON.stringify({ msg: "autopay start failed", error: String(err) }));
    return NextResponse.redirect(`${back}?problem=paypal`, 303);
  }
}
