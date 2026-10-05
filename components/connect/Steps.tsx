// A numbered sequence; the order is real (it is what happens, in order).
// Each step may carry its own state, so progress can be shown as it actually is.
export type StepState = "done" | "active" | "todo";

export function Steps({ items }: { items: { title: string; body: string; state?: StepState }[] }) {
  return (
    <ol className="grid">
      {items.map((item, i) => {
        const state = item.state;
        return (
          <li key={item.title} className="relative grid grid-cols-[2rem_1fr] gap-4 pb-6 last:pb-0">
            {i < items.length - 1 && <span aria-hidden className="absolute left-4 top-8 h-[calc(100%-2rem)] w-px bg-line" />}
            <span
              className={`z-10 grid h-8 w-8 place-items-center rounded-full border text-sm font-semibold tabular-nums ${
                state === "done"
                  ? "border-cleared bg-cleared text-white"
                  : state === "active"
                    ? "border-ink bg-ink text-white"
                    : "border-line bg-card text-muted"
              }`}
            >
              {state === "done" ? "✓" : i + 1}
              <span className="sr-only">{state === "done" ? " (done)" : state === "active" ? " (next)" : ""}</span>
            </span>
            <div className="min-w-0 pt-1">
              <p className={`font-medium ${state === "todo" ? "text-muted" : "text-ink"}`}>{item.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{item.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
