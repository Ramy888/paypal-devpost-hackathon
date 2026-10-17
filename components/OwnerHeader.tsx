import Link from "next/link";
import { Logo } from "./Logo";
import { ScrollActiveIntoView } from "./ScrollActiveIntoView";

const LINKS = [
  { href: "/", label: "Receivables" },
  { href: "/invoices/new", label: "New invoice" },
  { href: "/reminders", label: "Reminders" },
  { href: "/schedules", label: "Schedules" },
  { href: "/retainers", label: "Retainers" },
  { href: "/digest", label: "Digest" },
  { href: "/billing", label: "Plan" },
];

// Header for the freelancer's own pages; the current page is shown, not linked. The bar is always
// wide so all links fit beside the logo. Below laptop width the links become one row you swipe.
export function OwnerHeader({ current }: { current: string }) {
  return (
    <header className="sticky top-0 z-30 mb-6 border-b border-line bg-paper/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-3 sm:px-5 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
        <Logo href="/" />
        <nav id="owner-nav" aria-label="Main" className="-mx-4 flex gap-1 overflow-x-auto px-4 text-sm font-medium [scrollbar-width:none] max-lg:[mask-image:linear-gradient(to_right,black_85%,transparent)] lg:mx-0 lg:px-0">
          {LINKS.map((l) =>
            l.href === current ? (
              <span key={l.href} aria-current="page" className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-paper">
                {l.label}
              </span>
            ) : (
              <Link key={l.href} href={l.href} className="shrink-0 rounded-full px-3 py-1.5 text-muted transition-colors hover:bg-line hover:text-ink">
                {l.label}
              </Link>
            ),
          )}
        </nav>
        <ScrollActiveIntoView navId="owner-nav" />
      </div>
    </header>
  );
}
