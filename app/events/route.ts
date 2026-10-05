import { timingSafeEqual } from "node:crypto";
import { eventStore } from "@/lib/events.mjs";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const expected = process.env.ADMIN_TOKEN ?? "";
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return expected !== "" && a.length === b.length && timingSafeEqual(a, b);
}

// Recent verified webhook events, for checking deliveries from outside.
export function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(eventStore.recent());
}
