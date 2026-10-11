// What the freelancer can paste for an invoice check. Shared by the server check and the composer.
/** @type {readonly ["quote", "messages", "notes"]} */
export const SOURCES = ["quote", "messages", "notes"];
/** @type {Record<"quote" | "messages" | "notes", string>} */
export const SOURCE_LABELS = { quote: "Agreed quote", messages: "Client messages", notes: "Your notes" };
export const MAX_SOURCE_CHARS = 6000;
