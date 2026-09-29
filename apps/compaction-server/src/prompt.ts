import type { CompactionChunk } from "./contract.js";

export const COMPACTION_SYSTEM_PROMPT = `Create a detailed handoff summary for a Claude Code agent that will continue the task from the rendered conversation transcript.

Summarize the transcript instead of continuing the task. Fold new events into the existing checkpoint without duplicating information.

Preserve the user's current request and intent, important technical context, files and code involved, actions taken, decisions, commands and test results, errors and fixes, user feedback and constraints, current work, pending tasks, and the concrete next step. Preserve exact names, values, and code when they matter for continuation. Do not invent details absent from the supplied data. The continuing agent has the same tools; [image] and [document] mean omitted media, so advise rereading with Read, not OCR. Before responding, double-check factual accuracy and internal consistency.`;

export function compactionInput(
  checkpoint: string | undefined,
  chunk: CompactionChunk,
): string {
  const events = chunk.events.map((event, index) => {
    const header = `EVENT ${index + 1}`;
    if (event.kind === "message") {
      return `${header} — ${event.role.toUpperCase()}\n${event.text}`;
    }
    if (event.kind === "reasoning") {
      return `${header} — ASSISTANT REASONING\n${event.text}`;
    }
    const result = event.output === undefined ? "" : `\n\nTOOL RESULT${event.failed ? " (ERROR)" : ""}\n${event.output}`;
    return `${header} — ASSISTANT TOOL CALL: ${event.name}\n${event.input}${result}`;
  });

  return [
    ...(checkpoint ? [`EXISTING CHECKPOINT\n${checkpoint}`] : []),
    `NEW CONVERSATION EVENTS\n\n${events.join("\n\n")}`,
  ].join("\n\n");
}
