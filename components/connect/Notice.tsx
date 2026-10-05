import Link from "next/link";

// Short result page body: what happened, and the one thing to do next.
export function Notice({ title, body, action }: { title: string; body: string; action?: { href: string; label: string } }) {
  return (
    <section className="grid max-w-[60ch] gap-4 pt-10">
      <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-balance">{title}</h1>
      <p className="text-lg leading-relaxed text-muted">{body}</p>
      {action && (
        <Link href={action.href} className="w-fit rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-white hover:bg-ink/90">
          {action.label}
        </Link>
      )}
    </section>
  );
}
