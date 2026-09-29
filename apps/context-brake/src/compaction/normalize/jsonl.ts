export function parseJsonLines(raw: string): Array<Record<string, unknown>> {
  const records: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      const record = object(value);
      if (record) records.push(record);
    } catch {
      // Provider logs can end with a partially written record. Complete records
      // remain useful, so malformed lines are ignored.
    }
  }
  return records;
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function toolInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";

  const parts: string[] = [];
  for (const item of value) {
    const block = object(item);
    if (block && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}
