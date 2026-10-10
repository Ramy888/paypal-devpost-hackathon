// The "Not done yet" conversation on one part, oldest first.
export type Message = { id: string; partId: string; author: "client" | "freelancer"; kind: string; body: string; createdAt: string | Date };

const KIND: Record<string, string> = {
  hold: "marked it not done yet",
  reply: "",
  fixed: "marked it fixed",
  still_not_done: "said it's still not done",
  confirmed: "confirmed it's done",
  released: "lifted the hold",
  date_proposed: "proposed a new date",
  date_approved: "approved the new date",
};
const when = (d: string | Date) => new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });

// `viewer` is who is reading: their own messages say "You".
export function Thread({ messages, freelancer, client, viewer }: { messages: Message[]; freelancer: string; client: string; viewer: "client" | "freelancer" }) {
  return (
    <ol className="mt-2 grid gap-2 border-l-2 border-line pl-3">
      {messages.map((m) => {
        const who = m.author === viewer ? "You" : m.author === "client" ? client : freelancer;
        return (
          <li key={m.id} className="grid gap-0.5">
            <p className="text-xs text-muted">
              <span className="font-semibold text-ink">{who}</span>
              {KIND[m.kind] && ` ${KIND[m.kind]}`} · {when(m.createdAt)}
            </p>
            {m.body && <p dir="auto">{isDate(m.body) ? day(m.body) : m.body}</p>}
          </li>
        );
      })}
    </ol>
  );
}
