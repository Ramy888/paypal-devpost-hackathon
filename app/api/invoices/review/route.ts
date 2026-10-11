import Anthropic from "@anthropic-ai/sdk";
import { reviewInvoice, ReviewInputError } from "@/lib/reviewInvoice.mjs";
import { DEFAULT_MODEL } from "@/lib/draftInvoice.mjs";
import { isOwner } from "@/lib/server/owner";
import { allow } from "@/lib/server/rateLimit";
import { reviewEnabled } from "@/lib/server/features";

// Freelancer only. Checks a draft against pasted context; it never changes or sends the invoice.
// Each call spends the Anthropic API key, so it is capped.
const anthropic = new Anthropic();

export async function POST(req: Request) {
  if (!reviewEnabled()) return Response.json({ error: "Invoice checks are turned off." }, { status: 404 });
  if (!(await isOwner())) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!allow("review", 20, 60 * 60_000)) {
    return Response.json({ error: "Check limit reached (20 an hour). You can still send the invoice." }, { status: 429 });
  }
  const { draft, context } = await req.json().catch(() => ({ draft: null, context: null }));
  try {
    const review = await reviewInvoice({ anthropic, draft, context, model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL });
    return Response.json(review);
  } catch (err) {
    if (err instanceof ReviewInputError) return Response.json({ error: err.message }, { status: 400 });
    // Logs the status only: the pasted context is private and stays out of logs.
    console.error(JSON.stringify({ msg: "review failed", status: err instanceof Anthropic.APIError ? err.status : "unreadable" }));
    return Response.json({ error: "The check is unavailable right now. You can still send the invoice." }, { status: 502 });
  }
}
