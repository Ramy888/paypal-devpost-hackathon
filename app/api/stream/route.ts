import { eventStore } from "@/lib/events.mjs";
import { isOwner } from "@/lib/server/owner";

export const dynamic = "force-dynamic";

const PING_MS = 25_000;

// Server-Sent Events: pushes each verified invoice event to open dashboards.
export async function GET(req: Request) {
  if (!(await isOwner())) return new Response("Sign in first.", { status: 401 });
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const unsubscribe = eventStore.subscribe((e: unknown) => send(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => send(": ping\n\n"), PING_MS);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
      send(": connected\n\n");
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
