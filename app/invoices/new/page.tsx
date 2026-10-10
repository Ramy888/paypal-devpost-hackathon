import type { Metadata } from "next";
import { OwnerHeader } from "@/components/OwnerHeader";
import { redirect } from "next/navigation";
import { isOwner } from "@/lib/server/owner";
import { Composer } from "@/components/invoices/Composer";
import { now } from "@/lib/server/clock.mjs";
import { headers } from "next/headers";
import { countryFromRequest, currencyForCountry } from "@/lib/currency.mjs";

export const metadata: Metadata = { title: "New invoice · CollectPilot" };

export default async function NewInvoicePage() {
  if (!(await isOwner())) redirect("/login");
  return (
    <div className="min-h-full bg-paper">
      <OwnerHeader current="/invoices/new" />
      <main className="mx-auto grid max-w-3xl gap-6 px-5 pb-16">
        <div className="grid gap-2 pt-2">
          <h1 className="font-display text-4xl font-semibold tracking-tight">New invoice</h1>
          <p className="text-muted">
            Say or type who to bill and for what, in English or Arabic. You check the draft before anything is sent.
          </p>
        </div>
        <Composer
          freelancerName={process.env.FREELANCER_NAME ?? "Your studio"}
          todayIso={(await now()).toISOString().slice(0, 10)}
          defaultCurrency={currencyForCountry(countryFromRequest(await headers()))}
        />
      </main>
    </div>
  );
}
