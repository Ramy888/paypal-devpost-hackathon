// A numbered sequence; the order is real (it is what happens, in order).
export function Steps({ items, current }: { items: { title: string; body: string }[]; current?: number }) {
  return (
    <ol className="grid">
      {items.map((item, i) => {
        const done = current !== undefined && i < current;
        const active = current === i;
        return (
          <li key={item.title} className="relative grid grid-cols-[2rem_1fr] gap-4 pb-6 last:pb-0">
            {i < items.length - 1 && <span aria-hidden className="absolute left-4 top-8 h-[calc(100%-2rem)] w-px bg-line" />}
            <span
              className={`z-10 grid h-8 w-8 place-items-center rounded-full border text-sm font-semibold tabular-nums ${
                done
                  ? "border-cleared bg-cleared text-white"
                  : active
                    ? "border-ink bg-ink text-white"
                    : "border-line bg-card text-muted"
              }`}
            >
              {done ? "✓" : i + 1}
            </span>
            <div className="min-w-0 pt-1">
              <p className="font-medium text-ink">{item.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{item.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
