import Link from "next/link";
import { LogoMark } from "@/components/Logo";

export default function NotFound() {
  return (
    <main className="mx-auto grid min-h-full w-full max-w-md content-center justify-items-start gap-4 px-5 py-20">
      <LogoMark size={44} />
      <h1 className="font-display text-3xl font-semibold tracking-tight">This page didn&apos;t land.</h1>
      <p className="text-muted">The link may be old or mistyped. Payment links from your freelancer start with /pay/.</p>
      <Link href="/" className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-white hover:bg-cleared">
        Back to CollectPilot
      </Link>
    </main>
  );
}
