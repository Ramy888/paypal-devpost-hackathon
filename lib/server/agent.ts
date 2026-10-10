import Anthropic from "@anthropic-ai/sdk";
import { runSchedules, loadOverrides } from "@/lib/server/schedules";
import { serialized } from "@/lib/server/queue";
import { tick } from "@/lib/reminders.mjs";
import { DEFAULT_MODEL } from "@/lib/draftInvoice.mjs";
import { pgStore } from "./db.mjs";
import { now } from "./clock.mjs";
import { paypal } from "./paypal";
import { allow } from "./rateLimit";
import { ownerIsPro } from "./pro";


/**
 * One reminder-agent pass. `draft` spends the Anthropic API key, so only the freelancer's
 * own actions (or AUTOPILOT_DRAFTING=on) turn it on; the background timer only sends.
 * Passes never overlap.
 */
export async function runTick({ draft }: { draft: boolean }) {
  // Passes run one at a time, behind any approval that is creating a chunk invoice.
  return serialized(() => onePass(draft));
}

async function onePass(draft: boolean) {
  // Payment schedules first: a part auto-pay collects today needs no reminder.
  const schedules = await runSchedules().catch((err) => {
    console.error(JSON.stringify({ msg: "schedules pass failed", error: String(err) }));
    return null;
  });
  const result = await tick({
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
    overrides: await loadOverrides(),
  });
  console.log(JSON.stringify({ msg: "agent tick", draft, ...result, schedules }));
  return { ...result, schedules };
}
