import Link from "next/link";

const LINKS = [
  { href: "/", label: "Receivables" },
  { href: "/invoices/new", label: "New invoice" },
  { href: "/reminders", label: "Reminders" },
  { href: "/retainers", label: "Retainers" },
  { href: "/digest", label: "Digest" },
  { href: "/billing", label: "Plan" },
];

// Header for the freelancer's own pages; the current page is shown, not linked.
export function OwnerHeader({ current }: { current: string }) {
  return (
    <header className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-6">
      <Link href="/" className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
        <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-ink text-[12px] text-paper">
          CP
        </span>
        CollectPilot
      </Link>
      <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
        {LINKS.map((l) =>
          l.href === current ? (
            <span key={l.href} aria-current="page" className="text-ink">
              {l.label}
            </span>
          ) : (
            <Link key={l.href} href={l.href} className="text-cleared hover:underline">
              {l.label}
            </Link>
          ),
        )}
      </nav>
    </header>
  );
}
