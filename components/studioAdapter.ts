import type { AgAiEvent, AgAiHistoryStore, AgAiThread, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from "ag-studio";

// AG Studio's LLM boundary, answered by Claude through /api/studio-ai (the key stays on the server).
// The route replies with the whole turn, which is then replayed to Studio as stream events.
export const claudeAdapter: AgLlmAdapter = {
  executeTurn(request: AgLlmRequest, options) {
    const complete: Promise<AgLlmResponse> = fetch("/api/studio-ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: options?.signal,
    }).then(async (res) => {
      const body = await res.json().catch(() => ({ error: "The AI sent an unreadable reply." }));
      if (res.ok) return body as AgLlmResponse;
      return { id: `error-${Date.now()}`, createdAt: Date.now(), status: "failed", error: { code: String(res.status), message: body.error }, output: [] };
    });

    async function* events(): AsyncGenerator<AgAiEvent> {
      const res = await complete;
      for (const item of res.output) {
        if (item.type === "message") {
          const text = item.content.map((c) => (c.type === "text" ? c.text : c.refusal)).join("");
          yield { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" };
          yield { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text };
          yield { type: "TEXT_MESSAGE_END", messageId: item.id };
        } else if (item.type === "function_call") {
          yield { type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name };
          yield { type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments };
          yield { type: "TOOL_CALL_END", toolCallId: item.callId };
        }
      }
    }
    return { stream: events(), complete };
  },
};

// Chat threads kept in memory for the page's lifetime. The dashboard remounts Studio on every
// live PayPal update (see ReceivablesDashboard), and this keeps the conversation across remounts.
const threads = new Map<string, AgAiThread>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export const pageHistory: AgAiHistoryStore = {
  async listThreads() {
    return [...threads.values()].map((t) => t.summary);
  },
  async loadThread(id) {
    return threads.get(id);
  },
  async saveThread(thread) {
    threads.set(thread.summary.threadId, thread);
    changed();
  },
  async deleteThread(id) {
    threads.delete(id);
    changed();
  },
  addEventListener(_type, listener) {
    listeners.add(listener as () => void);
  },
  removeEventListener(_type, listener) {
    listeners.delete(listener as () => void);
  },
};
