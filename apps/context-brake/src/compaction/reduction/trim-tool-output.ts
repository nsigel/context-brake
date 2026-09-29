import type { NormalizedEvent } from "../normalize/index.js";

export interface ToolOutputLimits {
  successfulOutputCharacters: number;
  failedOutputCharacters: number;
}

export function trimToolOutput(
  events: NormalizedEvent[],
  limits: ToolOutputLimits,
): NormalizedEvent[] {
  return events.map((event) => {
    if (event.kind !== "tool" || event.output === undefined) return event;
    const limit = event.failed === true
      ? limits.failedOutputCharacters
      : limits.successfulOutputCharacters;
    const output = trimMiddle(event.output, limit);
    return output === event.output ? event : { ...event, output };
  });
}

function trimMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 0) return `[${text.length} characters removed]`;

  let removed = text.length - limit;
  let marker = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    marker = `\n...[${removed} characters removed]...\n`;
    removed = text.length - Math.max(0, limit - marker.length);
  }
  marker = `\n...[${removed} characters removed]...\n`;
  if (marker.length >= limit) return text.slice(0, Math.max(0, limit - 1)) + "…";
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : "");
}
