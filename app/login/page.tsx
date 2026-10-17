import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isOwner } from "@/lib/server/owner";
import { LogoMark } from "@/components/Logo";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in · CollectPilot" };

export default async function LoginPage() {
  if (await isOwner()) redirect("/");
  return (
    <main className="mx-auto grid min-h-full max-w-sm content-center gap-6 px-5 py-16">
      <div className="grid gap-3">
        <LogoMark size={44} />
        <h1 className="font-display text-3xl font-semibold tracking-tight">Sign in to CollectPilot</h1>
        <p className="text-sm text-muted">For {process.env.FREELANCER_NAME ?? "the freelancer"}.</p>
      </div>
      <SignInForm />
    </main>
  );
}
