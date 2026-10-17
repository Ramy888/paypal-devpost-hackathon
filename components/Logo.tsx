import Link from "next/link";

// The CollectPilot mark: a C-shaped flight path that lands on a green dot, the payment arriving.
// app/icon.svg is the same drawing.
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg aria-hidden viewBox="0 0 32 32" width={size} height={size} className="shrink-0">
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <path d="M21.5 10.2A8 8 0 1 0 21.5 21.8" fill="none" stroke="var(--paper)" strokeWidth="3.6" strokeLinecap="round" />
      <circle cx="22.6" cy="16" r="2.9" fill="var(--landed)" />
    </svg>
  );
}

export function Logo({ href }: { href?: string }) {
  const body = (
    <>
      <LogoMark />
      <span className="font-display text-lg font-semibold tracking-tight text-ink">
        Collect<span className="text-cleared">Pilot</span>
      </span>
    </>
  );
  return href ? (
    <Link href={href} className="flex shrink-0 items-center gap-2.5 rounded-lg" aria-label="CollectPilot home">
      {body}
    </Link>
  ) : (
    <span className="flex shrink-0 items-center gap-2.5">{body}</span>
  );
}
