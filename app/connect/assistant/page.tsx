import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Chat } from "@/components/assistant/Chat";
import { clientPayer } from "@/lib/server/clientPayer";

export const metadata: Metadata = { title: "Payments assistant · CollectPilot", robots: { index: false } };

const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

export default async function AssistantPage() {
  await connection();
  const payer = await clientPayer();
  if (!payer) redirect("/connect");
  const freelancer = process.env.FREELANCER_NAME ?? "your freelancer";
  return (
    <div className="grid gap-6">
      <section className="grid gap-2 pt-4">
        <p className="text-sm font-medium text-cleared">Built into CollectPilot · no setup</p>
        <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-balance">Your payments assistant</h1>
        <p className="max-w-[60ch] text-muted">
          It sees what you owe {freelancer} and sets up payments with the PayPal account you approved, up to {money(payer.spendLimit)} per invoice. Nothing is
          paid until you tap Confirm.
        </p>
      </section>
      <Chat freelancer={freelancer} />
      <p className="text-xs text-muted">
        Prefer your own AI assistant? <Link href="/connect/done" className="font-medium text-cleared hover:underline">Connect it instead</Link>.
      </p>
    </div>
  );
}
