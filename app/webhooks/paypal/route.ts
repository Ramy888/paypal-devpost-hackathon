import { handleWebhook, MAX_BODY } from "@/lib/webhook.mjs";
import { eventStore } from "@/lib/events.mjs";
import { paypal } from "@/lib/server/paypal";

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length")) > MAX_BODY) {
    return Response.json({ error: "body too large" }, { status: 413 });
  }
  const result = await handleWebhook({
    headers: Object.fromEntries(req.headers),
    rawBody: await req.text(),
    webhookId: process.env.PAYPAL_WEBHOOK_ID ?? "",
    paypal: paypal(),
  });
  if (result.summary) {
    const isNew = eventStore.add(result.summary);
    console.log(JSON.stringify({ msg: isNew ? "webhook verified" : "webhook duplicate", ...result.summary }));
  } else if (result.status === 401) {
    console.log(JSON.stringify({ msg: "webhook signature rejected", transmission_id: req.headers.get("paypal-transmission-id") }));
  }
  return Response.json(result.body, { status: result.status });
}
