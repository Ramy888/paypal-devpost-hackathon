import type { ReactNode } from "react";
import { Logo } from "./Logo";

// Frame for the pages a client sees (connect, pay, retainer): logo, the sandbox notice, and a trust note.
export function PublicShell({ home, note, children }: { home?: string; note: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-paper">
      <header className="border-b border-line bg-card/70">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
          <Logo href={home} />
          <span className="rounded-full border border-pending/30 bg-pending-soft px-3 py-1 text-xs font-medium text-pending">PayPal sandbox · test money only</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-8 pb-16 sm:px-5">{children}</main>
      <footer className="border-t border-line">
        <p className="mx-auto flex max-w-3xl items-start gap-2 px-4 py-6 text-xs leading-relaxed text-muted sm:px-5">
          <svg aria-hidden viewBox="0 0 24 24" width="16" height="16" className="mt-px shrink-0 text-cleared" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          </svg>
          <span>{note}</span>
        </p>
      </footer>
    </div>
  );
}
