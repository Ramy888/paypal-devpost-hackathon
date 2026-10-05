// Starts the reminder autopilot once per server process.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL || process.env.AUTOPILOT === "off") return;
  const g = globalThis as typeof globalThis & { __collectpilotTimer?: NodeJS.Timeout };
  if (g.__collectpilotTimer) return;
  const { runTick } = await import("./lib/server/agent");
  const every = 10 * 60_000;
  g.__collectpilotTimer = setInterval(() => {
    runTick({ draft: process.env.AUTOPILOT_DRAFTING === "on" }).catch((err) =>
      console.error(JSON.stringify({ msg: "agent tick failed", error: String(err) })),
    );
  }, every);
}
