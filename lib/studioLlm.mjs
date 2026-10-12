// Translates between AG Studio's AI turn format (AgLlmRequest / AgLlmResponse) and the Claude
// Messages API, so Studio's built-in dashboard agents can run on Claude. Pure functions: the route
// in app/api/studio-ai calls Claude, and the browser adapter turns the reply into Studio events.
// Kept to this one file so a change in ag-studio's AI types is a contained fix.

export class StudioLlmError extends Error {}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const textOf = (content) =>
  (content ?? [])
    .map((c) => {
      if (c.type === "text") return c.text;
      throw new StudioLlmError(`Unsupported input content: ${c.type}`);
    })
    .join("\n");

function parseArgs(json) {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function toolChoice(choice) {
  if (choice === undefined) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (choice && typeof choice.name === "string") return { type: "tool", name: choice.name };
  throw new StudioLlmError("Unknown tool choice.");
}

/**
 * AgLlmRequest -> the parts of a Claude Messages request.
 * @returns {{ system: string, messages: any[], tools?: any[], tool_choice?: any, output_config?: any }}
 */
export function toAnthropic(req) {
  const system = [req.instructions ?? ""];
  const messages = [];
  // Consecutive items with the same role go into one message, as Claude requires alternation.
  const push = (role, block) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of req.input ?? []) {
    if (item.type === "message" && item.role === "system") system.push(textOf(item.content));
    else if (item.type === "message" && item.role === "user") {
      const text = textOf(item.content);
      if (text) push("user", { type: "text", text });
    } else if (item.type === "message" && item.role === "assistant") {
      for (const c of item.content ?? []) {
        const text = c.type === "text" ? c.text : c.type === "refusal" ? c.refusal : "";
        if (text) push("assistant", { type: "text", text });
      }
    } else if (item.type === "function_call") push("assistant", { type: "tool_use", id: item.callId, name: item.name, input: parseArgs(item.arguments) });
    else if (item.type === "function_call_output") push("user", { type: "tool_result", tool_use_id: item.callId, content: String(item.output ?? "") });
    // Reasoning items are Studio's record of a model's thinking; Claude doesn't take them back.
  }
  if (messages[0]?.role !== "user") throw new StudioLlmError("A conversation must start with the user.");

  const tools = (req.tools ?? []).map((t) => {
    if (!TOOL_NAME.test(t.name)) throw new StudioLlmError(`Bad tool name: ${t.name}`);
    return { name: t.name, description: t.description ?? "", input_schema: t.parameters ?? { type: "object" } };
  });
  const out = { system: system.filter(Boolean).join("\n\n"), messages };
  if (tools.length) out.tools = tools;
  const choice = toolChoice(req.toolChoice);
  if (choice && tools.length) out.tool_choice = choice;
  if (req.responseFormat?.type === "json") out.output_config = { format: { type: "json_schema", schema: req.responseFormat.schema } };
  return out;
}

/** A Claude message -> AgLlmResponse (output items Studio's loop reads and runs). */
export function fromAnthropic(msg) {
  const output = [];
  (msg.content ?? []).forEach((block, i) => {
    if (block.type === "text" && block.text) {
      output.push({ id: `${msg.id}-${i}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: block.text, annotations: [] }] });
    } else if (block.type === "tool_use") {
      output.push({ id: block.id, kind: "output", type: "function_call", callId: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}), status: "completed" });
    }
  });
  if (msg.stop_reason === "refusal") {
    output.push({ id: `${msg.id}-refusal`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Claude declined to answer this." }] });
  }
  const cut = msg.stop_reason === "max_tokens";
  return {
    id: msg.id,
    createdAt: Date.now(),
    status: cut ? "incomplete" : "completed",
    ...(cut && { incompleteDetails: { reason: "max_output_tokens" } }),
    output,
    ...(msg.usage && { usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens } }),
    ...(msg.model && { model: msg.model }),
  };
}
