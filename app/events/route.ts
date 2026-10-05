import { eventStore } from "@/lib/events.mjs";
import { bearerMatches } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

// Recent verified webhook events, for checking deliveries from outside.
export function GET(req: Request) {
  if (!bearerMatches(req, process.env.ADMIN_TOKEN)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(eventStore.recent());
}
