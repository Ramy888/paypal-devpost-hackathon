import Link from "next/link";

// Icon tabs driven by a ?tab= link, so they work without client JavaScript and each tab has a URL.
// The active tab shows its name; the others show only their icon (named for screen readers and on hover).

const ICONS = {
  agent: "M9 3h6M12 3v3m-6 3h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Zm3 4h.01M15 13h.01M9.5 16h5",
  autopay: "M4 12a8 8 0 0 1 13.66-5.66L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.66 5.66L4 15.5M4 20v-4.5h4.5",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9Zm4.3 13a1.94 1.94 0 0 0 3.4 0",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2m3.45-6.9L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.9A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.1Z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z",
  cancelled: "M18 6 6 18M6 6l12 12",
} as const;

export type TabIcon = keyof typeof ICONS;
export type Tab = { id: string; label: string; icon: TabIcon; count?: number };

function Icon({ name }: { name: TabIcon }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Tabs({ tabs, active, basePath, label }: { tabs: Tab[]; active: string; basePath: string; label: string }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 rounded-xl border border-line bg-card p-1">
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <Link
            key={t.id}
            href={`${basePath}?tab=${t.id}`}
            aria-current={on ? "page" : undefined}
            aria-label={on ? undefined : t.label}
            title={t.label}
            scroll={false}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
              on ? "bg-ink text-white" : "text-muted hover:bg-line hover:text-ink"
            }`}
          >
            <Icon name={t.icon} />
            {on && <span>{t.label}</span>}
            {typeof t.count === "number" && t.count > 0 && (
              <span className={`rounded-full px-1.5 text-xs tabular-nums ${on ? "bg-white/20" : "bg-line text-ink"}`}>{t.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** The tab to show: the one asked for if it exists, else the first. */
export const pickTab = (tabs: Tab[], asked: unknown) => (tabs.some((t) => t.id === asked) ? String(asked) : tabs[0].id);
