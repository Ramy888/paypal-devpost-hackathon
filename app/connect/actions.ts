"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revokeConnection } from "@/lib/connect.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal } from "@/lib/server/paypal";
import { unsign } from "@/lib/server/session";
import { COOKIE } from "@/lib/server/connectCookies";

// Hides the agent key for good once the client has saved it.
export async function confirmKeySaved() {
  const jar = await cookies();
  const payerId = unsign(jar.get(COOKIE.payer)?.value);
  if (payerId) await pgStore().markKeySaved(payerId);
  jar.delete({ name: COOKIE.reveal, path: "/connect" });
  redirect("/connect/done");
}

// Deletes the saved PayPal permission and disables the agent key.
export async function revoke() {
  const jar = await cookies();
  const payerId = unsign(jar.get(COOKIE.payer)?.value);
  if (payerId) await revokeConnection({ paypal: paypal(), store: pgStore(), payerId });
  jar.delete({ name: COOKIE.reveal, path: "/connect" });
  jar.delete({ name: COOKIE.payer, path: "/connect" });
  redirect("/connect/revoked");
}

// "Check connection": re-reads the connection; the page says whether the assistant has checked in.
export async function checkConnection() {
  redirect("/connect/done?checked=1");
}
