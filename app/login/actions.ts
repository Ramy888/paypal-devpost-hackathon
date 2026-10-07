"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { OWNER_COOKIE, ownerCookieValue, passcodeMatches } from "@/lib/server/owner";
import { allow } from "@/lib/server/rateLimit";

export async function signIn(_prev: string | null, form: FormData): Promise<string | null> {
  if (!allow("login", 10, 15 * 60_000)) return "Too many attempts. Try again in 15 minutes.";
  if (!passcodeMatches(String(form.get("passcode") ?? ""))) return "That passcode is not right.";
  (await cookies()).set(OWNER_COOKIE, ownerCookieValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  redirect("/");
}
