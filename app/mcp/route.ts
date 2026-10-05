import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { whatDoIOwe, payInvoice, AgentPayError } from "@/lib/agentPay.mjs";
import { eventStore } from "@/lib/events.mjs";
import { paypal } from "@/lib/server/paypal";
import { bearerMatches } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

// Spike: one payer. Their agent authenticates with AGENT_API_KEY and pays with the
// PayPal token they approved once. Later, each payer gets their own key and token.
function payerFor(req: Request) {
  if (!bearerMatches(req, process.env.AGENT_API_KEY)) return null;
  const email = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
  const vaultId = process.env.PAYPAL_SANDBOX_BUYER_VAULT_ID;
  return email && vaultId ? { email, vaultId } : null;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function buildServer(payer: { email: string; vaultId: string }) {
  const server = new McpServer({ name: "collectpilot", version: "0.1.0" });
  const spendLimit = Number(process.env.AGENT_SPEND_LIMIT ?? 1000);

  server.registerTool(
    "what_do_i_owe",
    {
      title: "What do I owe",
      description: "Lists the PayPal invoices your owner still owes through CollectPilot, most overdue first.",
      annotations: { readOnlyHint: true },
    },
    async () => text(await whatDoIOwe({ paypal: paypal(), payerEmail: payer.email })),
  );

  server.registerTool(
    "pay_invoice",
    {
      title: "Pay an invoice",
      description: `Pays one invoice in full with the PayPal account your owner approved for agent payments. Refuses invoices that are not addressed to your owner, already paid, or over the ${spendLimit} spending limit.`,
      inputSchema: { invoice_id: z.string().describe("invoice_id from what_do_i_owe, e.g. INV2-XXXX-XXXX-XXXX-XXXX") },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ invoice_id }) => {
      try {
        return text(await payInvoice({ paypal: paypal(), payer, invoiceId: invoice_id, spendLimit, eventStore }));
      } catch (err) {
        if (err instanceof AgentPayError) return { ...text({ paid: false, reason: err.code, message: err.message }), isError: true };
        throw err;
      }
    },
  );
  return server;
}

async function handle(req: Request) {
  const payer = payerFor(req);
  if (!payer) return Response.json({ error: "unauthorized" }, { status: 401 });
  const server = buildServer(payer);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}

export { handle as GET, handle as POST, handle as DELETE };
