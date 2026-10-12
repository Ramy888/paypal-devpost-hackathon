import { payInvoice, AgentPayError } from "@/lib/agentPay.mjs";
import { eventStore } from "@/lib/events.mjs";
import { pgStore } from "@/lib/server/db.mjs";
import { paypal, paypalOrders } from "@/lib/server/paypal";
import { now } from "@/lib/server/clock.mjs";
import { allow } from "@/lib/server/rateLimit";
import { clientPayer } from "@/lib/server/clientPayer";
import { isHeldInvoice } from "@/lib/server/schedules";

// The client tapped Confirm on a payment their assistant proposed. Every check runs again here;
// the proposal itself carries no authority.
export async function POST(req: Request) {
  const payer = await clientPayer();
  if (!payer) return Response.json({ error: "Connect with PayPal first." }, { status: 401 });
  if (!allow(`assistant-pay:${payer.id}`, 20, 60 * 60_000)) return Response.json({ error: "Too many payments in an hour. Try later." }, { status: 429 });
  const body = await req.json().catch(() => null);
  const invoiceId = String(body?.invoice_id ?? "");
  const amount = body?.amount === null || body?.amount === undefined ? undefined : Number(body.amount);
  if (!invoiceId) return Response.json({ error: "Which invoice?" }, { status: 400 });
  try {
    const result = await payInvoice({ paypal: paypal(), orders: paypalOrders(), payer, invoiceId, spendLimit: payer.spendLimit, amount, isHeld: isHeldInvoice, eventStore, now: await now() });
    await pgStore().recordPayment(payer.id, Number(result.amount));
    return Response.json(result);
  } catch (err) {
    if (err instanceof AgentPayError) return Response.json({ error: err.message, code: err.code }, { status: 409 });
    console.error(JSON.stringify({ msg: "assistant pay failed", error: String(err) }));
    return Response.json({ error: "PayPal didn't answer. Nothing was confirmed; check your PayPal activity before trying again." }, { status: 502 });
  }
}
