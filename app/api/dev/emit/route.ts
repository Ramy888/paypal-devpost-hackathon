import { eventStore } from "@/lib/events.mjs";

// Local development only: inject an invoice event without a PayPal webhook.
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const ev = await req.json();
  eventStore.add({ id: `DEV-${Date.now()}`, received_at: new Date().toISOString(), ...ev });
  return Response.json({ ok: true });
}
