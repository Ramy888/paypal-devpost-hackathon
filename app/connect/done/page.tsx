import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CopyField } from "@/components/connect/CopyField";
import { Steps } from "@/components/connect/Steps";
import { pgStore } from "@/lib/server/db.mjs";
import { unsign } from "@/lib/server/session";
import { COOKIE } from "@/lib/server/connectCookies";
import { confirmKeySaved, revoke } from "../actions";

export const metadata: Metadata = { title: "Agent connected · CollectPilot" };

const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

export default async function DonePage() {
  const jar = await cookies();
  const payerId = unsign(jar.get(COOKIE.payer)?.value);
  const payer = payerId ? await pgStore().findPayer(payerId) : null;
  if (!payer || payer.status !== "active") redirect("/connect");

  const agentKey = jar.get(COOKIE.reveal)?.value;
  const mcpUrl = `${process.env.APP_URL}/mcp`;
  const snippet = JSON.stringify(
    { mcpServers: { collectpilot: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${agentKey ?? "<your agent key>"}` } } } },
    null,
    2,
  );

  return (
    <div className="grid gap-8">
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
          <CopyField label="Setup for your AI assistant (MCP)" value={snippet} multiline />
          <p className="text-sm text-muted">
            Works with assistants that support MCP servers, such as Claude. Add the snippet to its MCP settings.
          </p>
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
          <CopyField label="Setup for your AI assistant (MCP)" value={snippet} multiline />
        </section>
      )}

      <section className="grid gap-4">
        <h2 className="font-display text-2xl font-semibold tracking-tight">What happens next</h2>
        <Steps
          current={1}
          items={[
            { title: "PayPal approval", body: "Done. CollectPilot may charge your PayPal account for invoices addressed to you." },
            { title: "Your agent checks what you owe", body: "Whenever you or your assistant ask, it lists open invoices, most overdue first." },
            { title: "It pays within your limit", body: `Invoices up to ${money(payer.spendLimit)} are paid in full. Larger ones are left for you.` },
            { title: "PayPal sends you a receipt", body: "Each payment shows in your PayPal activity, and the freelancer sees the invoice marked paid." },
          ]}
        />
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
