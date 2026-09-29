import type { NormalizedEvent } from "../normalize/index.js";

const READ_NAMES = new Set(["read", "Read", "file_read"]);
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const SELECTOR_RE = /^(.+?)(?::(\d[\d,\-+\s]*))?$/;

export function collapseSupersededReads(
  events: NormalizedEvent[],
): NormalizedEvent[] {
  // Pass 1: find first and last index per path key
  const firstIndex = new Map<string, number>();
  const lastIndex = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const key = readPathKey(events[i]!);
    if (key === undefined) continue;
    if (!firstIndex.has(key)) firstIndex.set(key, i);
    lastIndex.set(key, i);
  }

  // Pass 2: keep all events; replace intermediate read outputs with a marker
  return events.map((event, i) => {
    const key = readPathKey(event);
    if (key === undefined) return event;

    const fi = firstIndex.get(key)!;
    const li = lastIndex.get(key)!;
    if (i === fi || i === li) return event;

    // Intermediate read — preserve the event for causal context, drop the payload
    return { ...event, output: "[intermediate read; see latest read of this file]" };
  });
}

function readPathKey(event: NormalizedEvent): string | undefined {
  if (event.kind !== "tool") return undefined;
  if (!READ_NAMES.has(event.name)) return undefined;

  const filePath = extractFilePath(event.input);
  if (!filePath) return undefined;
  if (URL_SCHEME.test(filePath)) return undefined;

  const { path, selector } = splitSelector(filePath);
  return selector ? `${path}\0${selector}` : path;
}

function extractFilePath(input: string): string | undefined {
  if (input.startsWith("{")) {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      const p = parsed.path ?? parsed.file_path;
      if (typeof p === "string" && p) return p;
    } catch {
      // fall through
    }
  }

  const trimmed = input.trim();
  if (trimmed && !trimmed.includes("{") && !trimmed.includes("\n")) {
    return trimmed;
  }

  return undefined;
}

function splitSelector(filePath: string): { path: string; selector?: string } {
  const match = SELECTOR_RE.exec(filePath);
  if (!match || !match[2]) return { path: filePath };
  return { path: match[1]!, selector: match[2] };
}
