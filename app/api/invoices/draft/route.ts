import Anthropic from "@anthropic-ai/sdk";
import { draftInvoice, DEFAULT_MODEL } from "@/lib/draftInvoice.mjs";
import { isOwner } from "@/lib/server/owner";
import { allow } from "@/lib/server/rateLimit";
import { countryFromRequest, currencyForCountry } from "@/lib/currency.mjs";

// Freelancer only. Each call spends the Anthropic API key, so it is capped.
const anthropic = new Anthropic();

export async function POST(req: Request) {
  if (!(await isOwner())) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!allow("draft", 30, 60 * 60_000)) {
    return Response.json({ error: "Drafting limit reached (30 an hour). Fill the form by hand or try later." }, { status: 429 });
  }
  const { text } = await req.json().catch(() => ({ text: "" }));
  try {
    const defaultCurrency = currencyForCountry(countryFromRequest(req.headers));
    const draft = await draftInvoice({ anthropic, text: String(text ?? ""), model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL, defaultCurrency });
    return Response.json(draft);
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(JSON.stringify({ msg: "draft failed", status: err.status }));
      return Response.json({ error: "The drafting assistant is unavailable. Fill the form by hand." }, { status: 502 });
    }
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
