import Anthropic from "@anthropic-ai/sdk";
import { toAnthropic, fromAnthropic, StudioLlmError } from "@/lib/studioLlm.mjs";
import { DEFAULT_MODEL } from "@/lib/draftInvoice.mjs";
import { isOwner } from "@/lib/server/owner";
import { allow } from "@/lib/server/rateLimit";

// One turn for AG Studio's dashboard agents (the "Ask AI" panel on Receivables), answered by Claude.
// Freelancer only. The browser adapter in components/studioAdapter.ts sends Studio's turn here, so
// the API key stays on the server. Each question takes several turns, so the cap is per turn.
const anthropic = new Anthropic();
const MAX_BODY_BYTES = 1_500_000;
// How answers show in Studio's chat panel: it renders bold and lists, but not markdown tables.
const STYLE = `Formatting for this chat panel: never use markdown tables; use short bullet lists instead. Write amounts with their currency sign, e.g. $400.00.`;

export async function POST(req: Request) {
  if (!(await isOwner())) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!allow("studio-ai", 120, 60 * 60_000)) return Response.json({ error: "AI limit reached for this hour. Try again later." }, { status: 429 });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "This chat is too long. Start a new one." }, { status: 413 });
  try {
    const parts = toAnthropic(JSON.parse(raw));
    const msg = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 8000,
      ...parts,
      // Studio's instructions (schema and widget catalogue) repeat every turn: cache them.
      system: [{ type: "text", text: `${parts.system}\n\n${STYLE}`, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low", ...parts.output_config },
    } as Anthropic.MessageCreateParamsNonStreaming);
    return Response.json(fromAnthropic(msg));
  } catch (err) {
    if (err instanceof StudioLlmError || err instanceof SyntaxError) return Response.json({ error: err.message }, { status: 400 });
    // Logs the status only: dashboard data stays out of logs.
    console.error(JSON.stringify({ msg: "studio ai failed", status: err instanceof Anthropic.APIError ? err.status : String(err).slice(0, 200) }));
    return Response.json({ error: "The AI is unavailable right now. Try again in a minute." }, { status: 502 });
  }
}
