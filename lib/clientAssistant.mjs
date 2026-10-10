// The client's hosted assistant: Claude with three tools over the client's own CollectPilot data.
// It never moves money itself. propose_payment only checks a payment; the client confirms it with
// a button, and that confirmation runs the real charge (payInvoice) with the same checks again.
import { whatDoIOwe, preparePayment, AgentPayError } from "./agentPay.mjs";
import { holdPartOp } from "./scheduleOps.mjs";
import { ScheduleError } from "./schedules.mjs";

export const MAX_TOOL_ROUNDS = 6;
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const ASSISTANT_TOOLS = [
  {
    name: "what_do_i_owe",
    description:
      "Lists what the client still owes their freelancer: open PayPal invoices (with invoice_id, amount due, due date, days overdue) and milestone schedules (with part_id, due date, status, and whether auto-pay is on). Call this before answering any question about money owed or before proposing a payment.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "propose_payment",
    description:
      "Checks a payment the client asked for and shows them a Confirm button for it. It does NOT pay: nothing is charged until the client taps Confirm. Use amount null to pay everything due on the invoice, or a number to pay one part of an invoice that allows part payments. Propose one payment per invoice the client asked to pay.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string", description: "invoice_id from what_do_i_owe" },
        amount: { type: ["number", "null"], description: "Amount to pay, or null for everything due" },
      },
      required: ["invoice_id", "amount"],
      additionalProperties: false,
    },
  },
  {
    name: "hold_milestone",
    description:
      "Marks one milestone of the client's schedule \"Not done yet\" with a note to the freelancer saying what is missing. That milestone is then not charged or chased until it is sorted out; the others are unchanged. Only use it when the client says the work isn't done.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        part_id: { type: "string", description: "part_id from what_do_i_owe" },
        note: { type: "string", description: "What is missing, in the client's words" },
      },
      required: ["part_id", "note"],
      additionalProperties: false,
    },
  },
];

export function assistantSystem({ freelancer }) {
  return `You are the payments assistant of a client who works with ${freelancer}, a freelancer who bills through CollectPilot and PayPal.
You help the client see what they owe and pay it, using only the tools you have.

How you work:
- Look things up with what_do_i_owe before answering about amounts, dates or invoices. Never guess numbers.
- You cannot pay by yourself. When the client asks to pay, call propose_payment for each invoice; the client then sees a Confirm button. Say clearly that nothing is paid until they tap Confirm. Never say a payment went through.
- If a proposal is refused (for example over their limit or not payable), explain why in plain words and what they can do instead.
- Use hold_milestone only when the client says a milestone's work isn't done; pass their reason as the note.
- Be brief and concrete: amounts with currency, dates like "Oct 24". Reply in the language the client writes in (English or Arabic).
- Write plain text only: the chat shows text exactly as written. No markdown: no tables, no asterisks or bold, no headings. For a list, put each item on its own line starting with "- ".
- The client's message may start with an update from CollectPilot listing payments they confirmed since your last reply. Those are paid; don't ask them to confirm again.`;
}

const asText = (value) => JSON.stringify(value);

/** Runs the tool calls of one assistant turn. Returns tool_result blocks and any payment proposals. */
export async function runAssistantTools({ calls, ctx }) {
  const results = [];
  const proposals = [];
  for (const call of calls) {
    let content;
    let isError = false;
    try {
      if (call.name === "what_do_i_owe") {
        const invoices = await whatDoIOwe({ paypal: ctx.paypal, payerEmail: ctx.payer.email, now: ctx.now });
        const schedules = await ctx.store.listSchedulesForPayer({ payerId: ctx.payer.id, email: ctx.payer.email });
        const withParts = [];
        for (const s of schedules) {
          const parts = await ctx.store.listParts(s.id);
          withParts.push({
            title: s.title,
            auto_pay: s.autopay,
            milestones: parts.map((p) => ({
              part_id: p.id,
              name: p.name,
              amount: p.amount,
              currency: s.currency,
              due_date: p.dueDate,
              status: p.status === "on_hold" ? "not done yet (on hold)" : p.status,
              auto_pay: s.autopay && p.autopay !== false,
            })),
          });
        }
        content = asText({ spend_limit_per_invoice: ctx.payer.spendLimit, invoices, schedules: withParts });
      } else if (call.name === "propose_payment") {
        const { invoice_id: invoiceId, amount } = call.input ?? {};
        const { inv, value } = await preparePayment({ paypal: ctx.paypal, payer: ctx.payer, invoiceId, spendLimit: ctx.payer.spendLimit, amount: amount ?? undefined });
        const proposal = {
          invoice_id: inv.id,
          invoice_number: inv.detail?.invoice_number ?? inv.id,
          amount: value,
          currency: (inv.due_amount ?? inv.amount)?.currency_code ?? "USD",
          full: Number(value) >= Number((inv.due_amount ?? inv.amount)?.value ?? 0),
        };
        proposals.push(proposal);
        content = asText({ proposed: true, paid: false, ...proposal, next: "The client must tap Confirm to pay." });
      } else if (call.name === "hold_milestone") {
        const { part_id: partId, note } = call.input ?? {};
        const part = await ctx.store.findPart(partId);
        const mine = part ? (await ctx.store.listSchedulesForPayer({ payerId: ctx.payer.id, email: ctx.payer.email })).some((s) => s.id === part.scheduleId) : false;
        if (!mine) throw new ScheduleError("That milestone is not in your schedules.");
        await holdPartOp({ store: ctx.store, part, note, now: ctx.now });
        content = asText({ held: true, milestone: part.name });
      } else {
        throw new ScheduleError(`Unknown tool ${call.name}.`);
      }
    } catch (err) {
      if (!(err instanceof AgentPayError) && !(err instanceof ScheduleError)) throw err;
      isError = true;
      content = asText({ error: err.code ?? "REFUSED", message: err.message });
    }
    results.push({ type: "tool_result", tool_use_id: call.id, content, ...(isError && { is_error: true }) });
  }
  return { results, proposals };
}

/**
 * One chat turn: appends the client's message, loops Claude <-> tools until Claude answers, and
 * returns the updated history (append-only, assistant content kept as returned), the reply text
 * and the payment proposals to show as Confirm cards.
 */
// `confirmed`: payments the client confirmed (tapped Confirm) since the last reply, so Claude knows.
export async function assistantTurn({ anthropic, model, history, userText, ctx, confirmed = [] }) {
  const update = confirmed.length
    ? `Update from CollectPilot: since your last reply the client confirmed and paid: ${confirmed
        .map((c) => `${c.invoice_number} ${c.amount} ${c.currency} (PayPal capture ${c.capture})`)
        .join("; ")}.`
    : null;
  const content = update ? [{ type: "text", text: update }, { type: "text", text: userText }] : userText;
  const messages = [...history, { role: "user", content }];
  const proposals = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.beta.messages.create({
      model,
      max_tokens: 4000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: assistantSystem({ freelancer: ctx.freelancer }),
      tools: ASSISTANT_TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "refusal") {
      return { history: messages, reply: "I can't help with that one. I can show what you owe, set up payments for you to confirm, or hold a milestone.", proposals };
    }
    const calls = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || calls.length === 0) {
      const reply = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return { history: messages, reply: reply || "Done.", proposals };
    }
    if (round === MAX_TOOL_ROUNDS) break;
    const ran = await runAssistantTools({ calls, ctx });
    proposals.push(...ran.proposals);
    messages.push({ role: "user", content: ran.results });
  }
  return { history: messages, reply: "That took too many steps. Please ask again more simply.", proposals };
}
