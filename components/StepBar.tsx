// A horizontal step bar for a multi-step journey, shown at the top of each page in it.
// Steps are joined by a line that turns green as each step is done; each step says its status.
export type StepState = "done" | "active" | "todo";
export type Step = { title: string; state: StepState; status?: string };

export function StepBar({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <nav aria-label={label} className="rounded-xl border border-line bg-card px-3 py-4 sm:px-5">
      <ol className="grid" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((s, i) => (
          <li key={s.title} aria-current={s.state === "active" ? "step" : undefined} className="relative grid justify-items-center gap-1.5 px-1 text-center">
            {i < steps.length - 1 && (
              <span aria-hidden className={`absolute left-1/2 top-4 h-0.5 w-full ${s.state === "done" ? "bg-cleared" : "bg-line"}`} />
            )}
            <span
              className={`relative z-10 grid h-8 w-8 place-items-center rounded-full border-2 text-sm font-semibold tabular-nums ${
                s.state === "done"
                  ? "border-cleared bg-cleared text-white"
                  : s.state === "active"
                    ? "border-ink bg-ink text-white ring-4 ring-ink/10"
                    : "border-line bg-card text-muted"
              }`}
            >
              {s.state === "done" ? "✓" : i + 1}
            </span>
            <span className={`text-xs font-semibold leading-tight sm:text-sm ${s.state === "todo" ? "text-muted" : "text-ink"}`}>{s.title}</span>
            <span className={`text-[11px] leading-tight sm:text-xs ${s.state === "done" ? "text-cleared" : s.state === "active" ? "font-medium text-pending" : "text-muted"}`}>
              {s.status ?? (s.state === "done" ? "Done" : s.state === "active" ? "Now" : "Next")}
              <span className="sr-only">{s.state === "done" ? " (completed)" : s.state === "active" ? " (current step)" : " (not started)"}</span>
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** States for steps done in order: done ones, then the first not-done one active, the rest to do. */
export function statesInOrder(done: boolean[]): StepState[] {
  const next = done.indexOf(false);
  return done.map((d, i) => (d ? "done" : i === next ? "active" : "todo"));
}
