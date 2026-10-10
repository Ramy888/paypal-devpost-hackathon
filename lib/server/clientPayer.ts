import { cookies } from "next/headers";
import { pgStore } from "@/lib/server/db.mjs";
import { unsign } from "@/lib/server/session";
import { COOKIE } from "@/lib/server/connectCookies";

export type ClientPayer = { id: string; email: string; vaultId: string; spendLimit: number; firstUsedAt: Date | null };

/** The client whose PayPal approval this browser made (signed cookie), if it is still active. */
export async function clientPayer(): Promise<ClientPayer | null> {
  const payerId = unsign((await cookies()).get(COOKIE.payer)?.value);
  const row = payerId ? await pgStore().findPayer(payerId) : null;
  if (!row || row.status !== "active") return null;
  return { id: row.id, email: row.paypalEmail, vaultId: row.vaultId, spendLimit: row.spendLimit, firstUsedAt: row.firstUsedAt };
}
