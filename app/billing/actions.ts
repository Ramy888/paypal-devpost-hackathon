"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cancelPro } from "@/lib/proPlan.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { isOwner } from "@/lib/server/owner";

export async function cancelProAction() {
  if (!(await isOwner())) redirect("/login");
  await cancelPro({ paypal: paypal(), store: pgStore() });
  revalidatePath("/billing");
}
