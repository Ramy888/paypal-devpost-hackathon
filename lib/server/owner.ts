import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { sign, unsign } from "./session";

// The freelancer signs in with a passcode; a signed cookie marks the browser.
export const OWNER_COOKIE = "cp_owner";
const OWNER_VALUE = "owner";

export function passcodeMatches(given: string): boolean {
  const expected = process.env.FREELANCER_PASSCODE ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return expected !== "" && a.length === b.length && timingSafeEqual(a, b);
}

export const ownerCookieValue = () => sign(OWNER_VALUE);

export async function isOwner(): Promise<boolean> {
  return unsign((await cookies()).get(OWNER_COOKIE)?.value) === OWNER_VALUE;
}
