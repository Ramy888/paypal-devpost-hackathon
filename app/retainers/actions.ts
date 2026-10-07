"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createOffer, endRetainer, validateOffer } from "@/lib/retainers.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { isOwner } from "@/lib/server/owner";
import { ownerIsPro } from "@/lib/server/pro";

async function requireOwner() {
  if (!(await isOwner())) redirect("/login");
}

export async function createRetainerOffer(form: FormData) {
  await requireOwner();
  if (!(await ownerIsPro())) redirect("/billing");
  const checked = validateOffer({
    clientEmail: String(form.get("clientEmail") ?? ""),
    clientName: String(form.get("clientName") ?? ""),
    amount: form.get("amount"),
    currency: String(form.get("currency") ?? ""),
    description: String(form.get("description") ?? ""),
  });
  if (!checked.ok) redirect(`/retainers?error=${encodeURIComponent(String(checked.error))}`);
  // 128 random bits: the offer page is public, so its address must not be guessable.
  const publicId = randomBytes(16).toString("base64url");
  await createOffer({
    paypal: paypal(),
    store: pgStore(),
    offer: checked.offer,
    freelancerName: process.env.FREELANCER_NAME ?? "Your freelancer",
    publicId,
  });
  revalidatePath("/retainers");
  redirect(`/retainers?created=${publicId}`);
}

export async function endRetainerAction(id: string) {
  await requireOwner();
  const store = pgStore();
  const retainer = await store.findRetainer(id);
  if (retainer && retainer.status !== "cancelled") await endRetainer({ paypal: paypal(), store, retainer });
  revalidatePath("/retainers");
}
