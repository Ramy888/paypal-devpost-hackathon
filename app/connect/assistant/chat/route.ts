import Anthropic from "@anthropic-ai/sdk";
import { assistantTurn } from "@/lib/clientAssistant.mjs";
import { DEFAULT_MODEL } from "@/lib/draftInvoice.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { now } from "@/lib/server/clock.mjs";
import { allow } from "@/lib/server/rateLimit";
import { clientPayer } from "@/lib/server/clientPayer";
import { isHeldInvoice } from "@/lib/server/schedules";
import { eventStore } from "@/lib/events.mjs";

const anthropic = new Anthropic();
const MAX_HISTORY_BYTES = 300_000;

// One chat turn with the client's hosted assistant. The client is identified by their connection
// cookie; every tool acts only on that client's invoices and schedules. Each turn spends the
// freelancer's Anthropic key, so it is rate-limited per client.
export async function POST(req: Request) {
  const payer = await clientPayer();
  if (!payer) return Response.json({ error: "Connect with PayPal first." }, { status: 401 });
  if (!allow(`assistant:${payer.id}`, 40, 60 * 60_000)) {
    return Response.json({ error: "That's a lot of questions for one hour. Please try again a bit later." }, { status: 429 });
  }
  const body = await req.json().catch(() => null);
  const text = String(body?.text ?? "").trim().slice(0, 2000);
  const history = Array.isArray(body?.history) ? body.history : [];
  // Payments confirmed in this chat since the last reply (the client's own record; informational only).
  const confirmed = (Array.isArray(body?.confirmed) ? body.confirmed : []).slice(0, 10).map((c: Record<string, unknown>) => ({
    invoice_number: String(c.invoice_number ?? "").slice(0, 60),
    amount: String(c.amount ?? "").slice(0, 20),
    currency: String(c.currency ?? "").slice(0, 3),
    capture: String(c.capture ?? "").slice(0, 40),
  }));
  if (!text) return Response.json({ error: "Type a question first." }, { status: 400 });
  if (JSON.stringify(history).length > MAX_HISTORY_BYTES) return Response.json({ error: "This chat is long. Start a new one." }, { status: 413 });

  const store = pgStore();
  // Using the hosted assistant counts as the client's assistant checking in (setup step 3).
  if (!payer.firstUsedAt) await store.markUsed(payer.id);
  const ctx = { paypal: paypal(), store, payer, now: await now(), freelancer: process.env.FREELANCER_NAME ?? "your freelancer", isHeld: isHeldInvoice, eventStore };

  // One JSON object per line: {"step"} while it works, then {"done"} or {"error"}. The chat shows
  // each step, since a turn takes two or more Claude calls.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const out = await assistantTurn({
          anthropic,
          model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
          history,
          userText: text,
          confirmed,
          ctx,
          onStep: (step: string) => send({ type: "step", step }),
        });
        send({ type: "done", ...out });
      } catch (err) {
        send({ type: "error", error: failure(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

function failure(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "The assistant is busy. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) {
    console.error(JSON.stringify({ msg: "assistant bad request", error: err.message }));
    return "Something went wrong in this chat. Start a new one.";
  }
  if (err instanceof Anthropic.APIError) {
    console.error(JSON.stringify({ msg: "assistant api error", status: err.status }));
    return "The assistant is unavailable right now. Try again in a minute.";
  }
  console.error(JSON.stringify({ msg: "assistant failed", error: String(err) }));
  return "PayPal or CollectPilot didn't answer. Try again in a minute.";
}
