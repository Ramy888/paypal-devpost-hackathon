import { test } from "node:test";
import assert from "node:assert/strict";
import { toAnthropic, fromAnthropic, StudioLlmError } from "../lib/studioLlm.mjs";

// What AG Studio's agent loop sends for a turn: a question, an earlier tool call and its result.
const REQUEST = {
  instructions: "You are the lead agent.",
  input: [
    { id: "m0", kind: "input", type: "message", role: "system", content: [{ type: "text", text: "Dashboard: Receivables." }], status: "completed" },
    { id: "m1", kind: "input", type: "message", role: "user", content: [{ type: "text", text: "Which clients are at risk?" }], status: "completed" },
    { id: "r1", kind: "output", type: "reasoning", summary: [{ type: "summary", text: "thinking" }] },
    { id: "o1", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Let me look.", annotations: [] }] },
    { id: "c1", kind: "output", type: "function_call", callId: "call_1", name: "execute_query", arguments: '{"query":"risk"}' },
    { id: "c2", kind: "output", type: "function_call", callId: "call_2", name: "view_schema", arguments: "" },
    { type: "function_call_output", callId: "call_1", output: '{"rows":2}', status: "completed" },
    { type: "function_call_output", callId: "call_2", output: "schema", status: "completed" },
  ],
  tools: [{ name: "execute_query", description: "Runs a query.", parameters: { type: "object", properties: { query: { type: "string" } } } }],
  toolChoice: "required",
  responseFormat: { type: "text" },
};

test("Studio's conversation becomes Claude messages: tool calls as tool_use, results as tool_result, system text in the system prompt", () => {
  const out = toAnthropic(REQUEST);
  assert.equal(out.system, "You are the lead agent.\n\nDashboard: Receivables.");
  assert.deepEqual(out.messages, [
    { role: "user", content: [{ type: "text", text: "Which clients are at risk?" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "call_1", name: "execute_query", input: { query: "risk" } },
        { type: "tool_use", id: "call_2", name: "view_schema", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: '{"rows":2}' },
        { type: "tool_result", tool_use_id: "call_2", content: "schema" },
      ],
    },
  ]);
  assert.deepEqual(out.tools, [{ name: "execute_query", description: "Runs a query.", input_schema: { type: "object", properties: { query: { type: "string" } } } }]);
  assert.deepEqual(out.tool_choice, { type: "any" });
});

test("tool choice maps auto, none, required and a named tool", () => {
  const choice = (toolChoice) => toAnthropic({ ...REQUEST, toolChoice }).tool_choice;
  assert.deepEqual(choice("auto"), { type: "auto" });
  assert.deepEqual(choice("none"), { type: "none" });
  assert.deepEqual(choice({ name: "execute_query" }), { type: "tool", name: "execute_query" });
  assert.equal(choice(undefined), undefined);
});

test("a JSON response format becomes structured output with its schema", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const out = toAnthropic({ ...REQUEST, responseFormat: { type: "json", name: "verdict", schema } });
  assert.deepEqual(out.output_config.format, { type: "json_schema", schema });
});

test("a conversation must start with the user, and bad tool names are refused", () => {
  assert.throws(() => toAnthropic({ ...REQUEST, input: REQUEST.input.slice(3) }), StudioLlmError);
  assert.throws(() => toAnthropic({ ...REQUEST, tools: [{ name: "bad name!", description: "", parameters: {} }] }), StudioLlmError);
  assert.throws(() => toAnthropic({ ...REQUEST, input: [{ kind: "input", type: "message", role: "user", content: [{ type: "image", detail: "auto", imageUrl: "x" }] }] }), StudioLlmError);
});

test("Claude's reply becomes Studio output items: text as a message, tool_use as a function call", () => {
  const out = fromAnthropic({
    id: "msg_1",
    model: "claude-opus-5-5",
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [
      { type: "text", text: "Two clients are at risk." },
      { type: "tool_use", id: "toolu_1", name: "add_widget", input: { type: "bar" } },
    ],
  });
  assert.equal(out.id, "msg_1");
  assert.equal(out.status, "completed");
  assert.equal(out.model, "claude-opus-5-5");
  assert.deepEqual(out.output, [
    { id: "msg_1-0", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Two clients are at risk.", annotations: [] }] },
    { id: "toolu_1", kind: "output", type: "function_call", callId: "toolu_1", name: "add_widget", arguments: '{"type":"bar"}', status: "completed" },
  ]);
});

test("a refusal and a cut-off reply are reported, not hidden", () => {
  const refused = fromAnthropic({ id: "m", stop_reason: "refusal", content: [] });
  assert.equal(refused.output[0].content[0].type, "refusal");
  const cut = fromAnthropic({ id: "m", stop_reason: "max_tokens", content: [{ type: "text", text: "Half" }] });
  assert.equal(cut.status, "incomplete");
  assert.deepEqual(cut.incompleteDetails, { reason: "max_output_tokens" });
});
