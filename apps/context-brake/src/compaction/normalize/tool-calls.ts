import type { NormalizedEvent } from "./types.js";

export function addToolCall(
  events: NormalizedEvent[],
  name: unknown,
  input: string,
): number {
  events.push({
    kind: "tool",
    name: typeof name === "string" && name ? name : "unknown",
    input,
  });
  return events.length - 1;
}

export function addToolResult(
  events: NormalizedEvent[],
  callIndex: number | undefined,
  output: string,
  failed = false,
): void {
  if (callIndex === undefined) return;

  const call = events[callIndex];
  if (!call || call.kind !== "tool") return;
  events[callIndex] = { ...call, output, ...(failed ? { failed: true } : {}) };
}
