import { contentText, object, parseJsonLines, toolInput } from "./jsonl.js";
import { addToolCall, addToolResult } from "./tool-calls.js";
import type { NormalizedEvent } from "./types.js";

export function normalizeCodex(raw: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const toolCalls = new Map<string, number>();

  for (const record of parseJsonLines(raw)) {
    const payload = object(record.payload);

    if (record.type === "compacted") {
      const summary = typeof payload?.message === "string" && payload.message
        ? payload.message
        : undefined;
      events.push(summary ? { kind: "boundary", summary } : { kind: "boundary" });
      continue;
    }

    if (record.type === "session_meta") {
      const baseInstructions = object(payload?.base_instructions);
      if (typeof baseInstructions?.text === "string" && baseInstructions.text) {
        events.push({ kind: "runtime_instructions", text: baseInstructions.text });
      }
      continue;
    }

    if (record.type === "event_msg") {
      if (payload?.type === "agent_reasoning" && typeof payload.text === "string" && payload.text) {
        events.push({ kind: "reasoning", text: payload.text });
      }
      continue;
    }

    if (record.type !== "response_item" || !payload) continue;

    if (payload.type === "message") {
      const text = contentText(payload.content);
      if (!text) continue;
      if (payload.role === "user" || payload.role === "assistant") {
        events.push({ kind: "message", role: payload.role, text });
      } else if (payload.role === "system" || payload.role === "developer") {
        events.push({ kind: "runtime_instructions", text });
      }
      continue;
    }

    if (payload.type === "reasoning") {
      const text = contentText(payload.summary);
      if (text) events.push({ kind: "reasoning", text });
      continue;
    }

    if (payload.type === "function_call") {
      const index = addToolCall(
        events,
        payload.name,
        toolInput(payload.arguments),
      );
      if (typeof payload.call_id === "string" && payload.call_id) toolCalls.set(payload.call_id, index);
      continue;
    }

    if (payload.type === "custom_tool_call") {
      const index = addToolCall(events, payload.name, toolInput(payload.input));
      if (typeof payload.call_id === "string" && payload.call_id) toolCalls.set(payload.call_id, index);
      continue;
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
      addToolResult(
        events,
        typeof payload.call_id === "string" ? toolCalls.get(payload.call_id) : undefined,
        output,
        payload.status === "failed" || payload.is_error === true,
      );
    }
  }

  return events;
}
