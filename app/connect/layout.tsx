import Link from "next/link";

export default function ConnectLayout({ children }: LayoutProps<"/connect">) {
  return (
    <div className="min-h-full bg-paper">
      <header className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-6">
        <Link href="/connect" className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight text-ink">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-ink text-[12px] text-paper">
            CP
          </span>
          CollectPilot
        </Link>
        <span className="rounded-full border border-pending/30 bg-pending-soft px-3 py-1 text-xs font-medium text-pending">
          PayPal sandbox · test money only
        </span>
      </header>
      <main className="mx-auto max-w-3xl px-5 pb-16">{children}</main>
      <footer className="mx-auto max-w-3xl px-5 pb-10 text-xs leading-relaxed text-muted">
        CollectPilot never sees your PayPal password or card details. Every payment is made and receipted by PayPal.
      </footer>
    </div>
  );
}
