import Anthropic from "@anthropic-ai/sdk";
import { tick } from "@/lib/reminders.mjs";
import { DEFAULT_MODEL } from "@/lib/draftInvoice.mjs";
import { pgStore } from "./db.mjs";
import { now } from "./clock.mjs";
import { paypal } from "./paypal";
import { allow } from "./rateLimit";
import { ownerIsPro } from "./pro";

const g = globalThis as typeof globalThis & { __collectpilotTick?: Promise<unknown> };

/**
 * One reminder-agent pass. `draft` spends the Anthropic API key, so only the freelancer's
 * own actions (or AUTOPILOT_DRAFTING=on) turn it on; the background timer only sends.
 * Passes never overlap.
 */
export async function runTick({ draft }: { draft: boolean }) {
  if (g.__collectpilotTick) await g.__collectpilotTick.catch(() => {});
  const pass = tick({
    paypal: paypal(),
    anthropic: new Anthropic(),
    store: pgStore(),
    now: await now(),
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    freelancerName: process.env.FREELANCER_NAME ?? "Your freelancer",
    appUrl: process.env.APP_URL!,
    draft,
    autoSend: await ownerIsPro(),
    canSpend: () => allow("reminder-draft", 50, 24 * 60 * 60_000),
  });
  g.__collectpilotTick = pass;
  try {
    const result = await pass;
    console.log(JSON.stringify({ msg: "agent tick", draft, ...result }));
    return result;
  } finally {
    g.__collectpilotTick = undefined;
  }
}
