import { object, parseJsonLines, toolInput } from "./jsonl.js";
import { addToolCall, addToolResult } from "./tool-calls.js";
import type { NormalizedEvent } from "./types.js";

export function normalizeClaude(raw: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const toolCalls = new Map<string, number>();

  for (const record of parseJsonLines(raw)) {
    if (record.isSidechain === true) continue;
    if (record.type !== "user" && record.type !== "assistant") continue;

    const message = object(record.message);
    if (!message) continue;

    if (record.isCompactSummary === true) {
      const summary = typeof message.content === "string" ? message.content : "";
      events.push(summary ? { kind: "boundary", summary } : { kind: "boundary" });
      continue;
    }

    if (record.type === "user") {
      normalizeUserContent(message.content, events, toolCalls);
    } else {
      normalizeAssistantContent(message.content, events, toolCalls);
    }
  }

  return events;
}

function normalizeUserContent(
  content: unknown,
  events: NormalizedEvent[],
  toolCalls: Map<string, number>,
): void {
  if (typeof content === "string") {
    if (content) events.push({ kind: "message", role: "user", text: content });
    return;
  }
  if (!Array.isArray(content)) return;

  for (const item of content) {
    const block = object(item);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      events.push({ kind: "message", role: "user", text: block.text });
    } else if (block.type === "image") {
      events.push({ kind: "message", role: "user", text: "[image]" });
    } else if (block.type === "document") {
      events.push({ kind: "message", role: "user", text: "[document]" });
    } else if (block.type === "tool_result") {
      const output = toolResultText(block.content);
      addToolResult(events, typeof block.tool_use_id === "string" ? toolCalls.get(block.tool_use_id) : undefined, output, block.is_error === true);
    }
  }
}

function normalizeAssistantContent(
  content: unknown,
  events: NormalizedEvent[],
  toolCalls: Map<string, number>,
): void {
  if (!Array.isArray(content)) return;

  for (const item of content) {
    const block = object(item);
    if (!block) continue;
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      events.push({ kind: "reasoning", text: block.thinking });
    } else if (block.type === "text" && typeof block.text === "string" && block.text) {
      events.push({ kind: "message", role: "assistant", text: block.text });
    } else if (block.type === "tool_use") {
      const index = addToolCall(events, block.name, toolInput(block.input));
      if (typeof block.id === "string" && block.id) toolCalls.set(block.id, index);
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((item) => {
      const block = object(item);
      if (!block) return "";
      if (typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image]";
      if (block.type === "document") return "[document]";
      return "";
    }).filter(Boolean);
    return parts.join("\n") || JSON.stringify(content);
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}
