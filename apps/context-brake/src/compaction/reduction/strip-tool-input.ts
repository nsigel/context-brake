import type { NormalizedEvent } from "../normalize/index.js";

const READ_NAMES = new Set(["read", "Read", "file_read"]);
const BASH_NAMES = new Set(["bash", "Bash", "shell", "exec_command", "exec"]);

const MAX_BASH_INPUT_LENGTH = 200;

export function stripToolInput(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.map((event) => {
    if (event.kind !== "tool") return event;

    if (READ_NAMES.has(event.name)) {
      const stripped = stripReadInput(event.input);
      return stripped === event.input ? event : { ...event, input: stripped };
    }

    if (BASH_NAMES.has(event.name)) {
      const stripped = stripBashInput(event.input);
      return stripped === event.input ? event : { ...event, input: stripped };
    }

    return event;
  });
}

function stripReadInput(input: string): string {
  if (input.startsWith("{")) {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      const path = parsed.path ?? parsed.file_path;
      if (typeof path === "string" && path) {
        const selector = parsed.selector;
        if (typeof selector === "string" && selector) {
          return `${path}:${selector}`;
        }
        return path;
      }
    } catch {
      // Unparseable JSON — leave unchanged
    }
  }
  return input;
}

function stripBashInput(input: string): string {
  const newlineIdx = input.indexOf("\n");
  if (newlineIdx >= 0) {
    return input.slice(0, newlineIdx);
  }
  if (input.length > MAX_BASH_INPUT_LENGTH) {
    return input.slice(0, MAX_BASH_INPUT_LENGTH) + "…";
  }
  return input;
}
