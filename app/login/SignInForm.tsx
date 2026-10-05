"use client";

import { useActionState } from "react";
import { signIn } from "./actions";

export function SignInForm() {
  const [error, action, pending] = useActionState(signIn, null);
  return (
    <form action={action} className="grid gap-3 rounded-xl border border-line bg-card p-5">
      <label htmlFor="passcode" className="text-sm font-medium">
        Passcode
      </label>
      <input
        id="passcode"
        name="passcode"
        type="password"
        autoComplete="current-password"
        required
        className="rounded-md border border-line bg-paper px-3 py-2.5 text-ink"
      />
      {error && (
        <p role="alert" className="text-sm text-pending">
          {error}
        </p>
      )}
      <button disabled={pending} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
