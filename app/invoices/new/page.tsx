import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isOwner } from "@/lib/server/owner";
import { Composer } from "@/components/invoices/Composer";

export const metadata: Metadata = { title: "New invoice · CollectPilot" };

export default async function NewInvoicePage() {
  if (!(await isOwner())) redirect("/login");
  return (
    <div className="min-h-full bg-paper">
      <header className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-6">
        <Link href="/" className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-ink text-[12px] text-paper">
            CP
          </span>
          CollectPilot
        </Link>
        <Link href="/" className="text-sm font-medium text-cleared hover:underline">
          Receivables →
        </Link>
      </header>
      <main className="mx-auto grid max-w-3xl gap-6 px-5 pb-16">
        <div className="grid gap-2 pt-2">
          <h1 className="font-display text-4xl font-semibold tracking-tight">New invoice</h1>
          <p className="text-muted">
            Say or type who to bill and for what, in English or Arabic. You check the draft before anything is sent.
          </p>
        </div>
        <Composer freelancerName={process.env.FREELANCER_NAME ?? "Your studio"} />
      </main>
    </div>
  );
}
