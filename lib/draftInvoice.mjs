// Turns a freelancer's sentence or voice note (Arabic or English) into an invoice draft.
// The draft is only a proposal: the freelancer reviews and edits it before anything is sent.
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const DEFAULT_MODEL = "claude-opus-5-5";

const DraftSchema = z.object({
  client_name: z.string().describe("Client or company name, as said. Empty string if not mentioned."),
  client_email: z.string().describe("Client email if said or spelled out, else empty string."),
  currency: z.string().describe("ISO 4217 code if the freelancer named a currency, else an empty string."),
  items: z
    .array(
      z.object({
        name: z.string().describe("Short line-item name in the language the freelancer used."),
        quantity: z.number(),
        unit_amount: z.number().describe("Price per unit, as a plain number."),
      }),
    )
    .describe("At least one line item."),
  due_in_days: z.number().int().describe("Days from today until payment is due. Default 14 when not said."),
  note: z.string().describe("A one-line note to the client, in the client's language if clear, else the freelancer's."),
  language: z.enum(["en", "ar"]).describe("Language the freelancer spoke."),
  missing: z.array(z.string()).describe("Fields the freelancer still needs to fill in, e.g. client_email."),
});

const SYSTEM = `You draft invoices for a freelance video editor from what they say or type.
Extract only what they said. Never invent an email address, a price, or a client.
Amounts may be written in words or in Arabic numerals (e.g. "ألف ومئتين" = 1200, "١٢٠٠" = 1200).
"Dollars"/"دولار" means USD; "pounds"/"جنيه" means EGP; "euros"/"يورو" means EUR.
If something required is missing (client email, amount), leave it empty and list it in "missing".`;

/**
 * @param {{ anthropic: { messages: { parse: Function } }, text: string, model?: string, defaultCurrency?: string }} input
 */
export async function draftInvoice({ anthropic, text, model = DEFAULT_MODEL, defaultCurrency = "USD" }) {
  const input = text.trim();
  if (!input) throw new Error("Say or type what to bill.");
  if (input.length > 2000) throw new Error("Please keep it under 2,000 characters.");

  const response = await anthropic.messages.parse({
    model,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(DraftSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: input }],
  });
  if (response.stop_reason === "refusal") throw new Error("The assistant could not draft this invoice.");
  const draft = response.parsed_output;
  if (!draft) throw new Error("The assistant returned an unreadable draft. Please try again.");
  return normalizeDraft(draft, defaultCurrency);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cleans the model's draft so the review form starts from safe, consistent values.
// `defaultCurrency`: the freelancer's local currency, used when they didn't name one.
export function normalizeDraft(d, defaultCurrency = "USD") {
  const items = (d.items ?? [])
    .map((it) => ({
      name: String(it.name ?? "").trim(),
      quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
      unit_amount: Math.max(0, Math.round(Number(it.unit_amount) * 100) / 100 || 0),
    }))
    .filter((it) => it.name);
  const email = String(d.client_email ?? "").trim().toLowerCase();
  const due = Number.isInteger(d.due_in_days) && d.due_in_days >= 0 && d.due_in_days <= 365 ? d.due_in_days : 14;
  const currency = /^[A-Z]{3}$/.test(String(d.currency ?? "").toUpperCase()) ? d.currency.toUpperCase() : defaultCurrency;

  const missing = new Set(d.missing ?? []);
  if (!EMAIL.test(email)) missing.add("client_email");
  if (!items.length || items.every((it) => it.unit_amount === 0)) missing.add("amount");

  return {
    client_name: String(d.client_name ?? "").trim(),
    client_email: EMAIL.test(email) ? email : "",
    currency,
    items,
    due_in_days: due,
    note: String(d.note ?? "").trim(),
    language: d.language === "ar" ? "ar" : "en",
    missing: [...missing],
  };
}
