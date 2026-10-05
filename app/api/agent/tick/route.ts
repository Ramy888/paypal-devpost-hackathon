import { runTick } from "@/lib/server/agent";
import { isOwner } from "@/lib/server/owner";
import { bearerMatches } from "@/lib/server/auth";

// Runs one reminder-agent pass now. Freelancer (signed in) or a scheduler with AGENT_TICK_SECRET.
export async function POST(req: Request) {
  const scheduler = bearerMatches(req, process.env.AGENT_TICK_SECRET);
  if (!scheduler && !(await isOwner())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const draft = !scheduler || url.searchParams.get("draft") === "1";
  return Response.json(await runTick({ draft }));
}
