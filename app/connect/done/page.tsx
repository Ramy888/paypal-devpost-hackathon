import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CopyField } from "@/components/connect/CopyField";
import { StepBar, statesInOrder } from "@/components/StepBar";
import { CONNECT_STEPS } from "@/components/journeys";
import { pgStore } from "@/lib/server/db.mjs";
import { unsign } from "@/lib/server/session";
import { COOKIE } from "@/lib/server/connectCookies";
import { confirmKeySaved, revoke, checkConnection } from "../actions";

export const metadata: Metadata = { title: "Agent connected · CollectPilot" };

const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const day = (d: Date | string) => new Date(d).toLocaleDateString("en-US", { dateStyle: "medium" });

// Marks the first unfinished step as the one to do next.
export default async function DonePage({ searchParams }: PageProps<"/connect/done">) {
  const jar = await cookies();
  const payerId = unsign(jar.get(COOKIE.payer)?.value);
  const payer = payerId ? await pgStore().findPayer(payerId) : null;
  if (!payer || payer.status !== "active") redirect("/connect");

  const agentKey = jar.get(COOKIE.reveal)?.value;
  // An assistant that has used the key proves it was saved, even if the button was skipped.
  const keySaved = Boolean(payer.keySavedAt || payer.firstUsedAt || payer.paymentsCount > 0);
  const states = statesInOrder([true, keySaved, Boolean(payer.firstUsedAt), payer.paymentsCount > 0]);
  const statuses = [
    `Done ${day(payer.createdAt)}`,
    keySaved ? "Saved" : "Copy it below",
    payer.firstUsedAt ? `Checked in ${day(payer.firstUsedAt)}` : keySaved ? "Add the setup below" : undefined,
    payer.paymentsCount > 0 ? `${payer.paymentsCount} paid` : undefined,
  ];
  const mcpUrl = `${process.env.APP_URL}/mcp`;
  const { checked } = await searchParams;
  const keyText = agentKey ?? "<your agent key>";
  const claudeCode = `claude mcp add --transport http collectpilot ${mcpUrl} --header "Authorization: Bearer ${keyText}"`;
  const firstQuestion = "What do I owe on CollectPilot?";
  const snippet = JSON.stringify(
    { mcpServers: { collectpilot: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${agentKey ?? "<your agent key>"}` } } } },
    null,
    2,
  );

  return (
    <div className="grid gap-8">
      <StepBar label="Connect your AI agent" steps={CONNECT_STEPS.map((title, i) => ({ title, state: states[i], status: statuses[i] }))} />
      <section className="grid gap-4 pt-4">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-cleared text-2xl text-white" aria-hidden>
          ✓
        </span>
        <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-balance">Your agent is connected</h1>
        <dl className="grid gap-x-8 gap-y-2 rounded-xl border border-line bg-card p-5 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-muted">PayPal account</dt>
            <dd className="mt-0.5 truncate font-medium">{payer.paypalEmail}</dd>
          </div>
          <div>
            <dt className="text-muted">Limit per invoice</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{money(payer.spendLimit)}</dd>
          </div>
          <div>
            <dt className="text-muted">Connected</dt>
            <dd className="mt-0.5 font-medium">{new Date(payer.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</dd>
          </div>
        </dl>
      </section>

      {agentKey ? (
        <section className="grid gap-5 rounded-xl border-2 border-ink bg-card p-6">
          <div className="grid gap-1">
            <h2 className="font-display text-2xl font-semibold tracking-tight">Save your agent key now</h2>
            <p className="text-sm leading-relaxed text-muted">
              This is the only time we show it. Anyone with this key can ask CollectPilot to pay your invoices, so keep it with your
              other secrets.
            </p>
          </div>
          <CopyField label="Agent key" value={agentKey} />
          <p className="text-sm text-muted">The setup below already includes this key, so you can copy it in one go.</p>
          <form action={confirmKeySaved}>
            <button type="submit" className="rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-white hover:bg-ink/90">
              I&apos;ve saved my key
            </button>
          </form>
        </section>
      ) : (
        <section className="grid gap-2 rounded-xl border border-line bg-card p-6">
          <h2 className="font-medium">Your agent key is hidden</h2>
          <p className="text-sm leading-relaxed text-muted">
            For your safety it was shown only once. If you lost it, revoke access below and connect again to get a new key.
          </p>
        </section>
      )}

      {payer.firstUsedAt ? (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-cleared/30 bg-cleared-soft p-5 text-sm text-cleared">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-full bg-cleared text-white">✓</span>
          <p className="min-w-0 flex-1">
            <strong>Your assistant is connected.</strong> It first checked in on {day(payer.firstUsedAt)}. Ask it “{firstQuestion}” any time.
          </p>
        </section>
      ) : (
        <section className={`grid gap-5 rounded-xl border bg-card p-6 ${keySaved ? "border-2 border-ink" : "border-line"}`}>
          <div className="grid gap-1">
            <h2 className="font-display text-2xl font-semibold tracking-tight">Connect your assistant</h2>
            <p className="text-sm leading-relaxed text-muted">
              Add CollectPilot to your AI assistant once. {agentKey ? "Your key is already filled in below." : "Replace <your agent key> with the key you saved."}
            </p>
          </div>
          <ol className="grid gap-5 text-sm">
            <li className="grid gap-2">
              <p className="font-medium">1. Add CollectPilot to your assistant</p>
              <CopyField label="Claude Code: run this in a terminal" value={claudeCode} />
              <CopyField label="Claude Desktop, Cursor or any MCP app: paste into its MCP settings" value={snippet} multiline />
            </li>
            <li className="grid gap-2">
              <p className="font-medium">2. Ask it your first question</p>
              <CopyField label="Ask your assistant" value={firstQuestion} />
            </li>
            <li className="grid gap-2">
              <p className="font-medium">3. Check the connection</p>
              <form action={checkConnection} className="flex flex-wrap items-center gap-3">
                <button className="rounded-lg bg-ink px-4 py-2.5 font-semibold text-white hover:bg-ink/90">Check connection</button>
                {checked === "1" && (
                  <span role="status" className="text-pending">
                    Not connected yet: we haven&apos;t heard from your assistant. Check the key is in the setup, restart the assistant, then ask it the question above.
                  </span>
                )}
              </form>
            </li>
          </ol>
        </section>
      )}

      <section className="grid gap-2 rounded-xl border border-line bg-card p-6">
        <h2 className="font-medium">How payments work</h2>
        <ul className="grid gap-1.5 text-sm leading-relaxed text-muted">
          <li>
            Your assistant can pay up to {money(payer.spendLimit)} per invoice: everything that&apos;s due, or one part of an invoice that&apos;s paid in
            parts. What it pays on one invoice adds up toward that limit; anything above it is left for you.
          </li>
          <li>
            Work billed in milestones: each milestone has its own PayPal invoice, so your assistant pays each one as it comes due. If you turned on
            auto-pay on the schedule&apos;s page, CollectPilot charges each milestone on its date instead. There you can switch any milestone off or
            mark it “Not done yet”.
          </li>
          <li>PayPal emails you a receipt for every payment, and it shows in your PayPal activity.</li>
          <li>The freelancer sees the invoice marked paid straight away.</li>
        </ul>
      </section>

      <section className="grid gap-3 rounded-xl border border-line bg-card p-6 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <h2 className="font-medium">Revoke access</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">Removes the PayPal permission and disables your agent key straight away.</p>
        </div>
        <form action={revoke}>
          <button type="submit" className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold text-ink hover:border-ink">
            Revoke access
          </button>
        </form>
      </section>
    </div>
  );
}
