import { open, stat } from "node:fs/promises";
import type { Provider, ThreadRow, UsageSnapshot } from "./types.js";

export const PARSER_VERSION = 3;
const INITIAL_TAIL_BYTES = 64 * 1024;
const MAX_REVERSE_TAIL_BYTES = 16 * 1024 * 1024;

export interface ParsedSource {
  usage: UsageSnapshot | null;
  usageKind: "invocation" | "checkpoint" | null;
  effort: string | null;
  sourceDevice: number;
  sourceInode: number;
  sourceSizeBytes: number;
  sourceMtimeMs: number;
  sourceOffsetBytes: number;
}

/**
 * Reads the latest provider usage and returns updated transcript metadata.
 * A valid saved cursor is read forward for incremental updates; new, replaced,
 * or invalidated transcripts fall back to a bounded reverse-tail scan.
 */
export async function readLatestTranscriptUsage(
  provider: Provider,
  transcriptPath: string,
  existingThread: ThreadRow | null,
): Promise<ParsedSource> {
  const metadata = await stat(transcriptPath);
  const mtimeMs = Math.trunc(metadata.mtimeMs);
  const sameFile =
    existingThread?.sourceDevice === metadata.dev &&
    existingThread.sourceInode === metadata.ino &&
    existingThread.parserVersion === PARSER_VERSION;

  const canReadForward =
    sameFile &&
    existingThread.sourceOffsetBytes !== null &&
    existingThread.sourceOffsetBytes <= metadata.size &&
    !(existingThread.sourceSizeBytes === metadata.size && existingThread.sourceMtimeMs !== mtimeMs);

  let usage: UsageSnapshot | null = null;
  let usageKind: ParsedSource["usageKind"] = null;
  let effort: string | null = null;
  let offset: number;

  if (canReadForward) {
    const result = await readForward(
      transcriptPath,
      existingThread.sourceOffsetBytes ?? 0,
      metadata.size,
      provider,
    );
    usage = result.usage;
    usageKind = result.usageKind;
    effort = result.effort;
    offset = result.offset;
  } else {
    const result = await reverseTail(transcriptPath, metadata.size, provider);
    usage = result.usage;
    usageKind = result.usageKind;
    effort = result.effort;
    offset = result.offset;
  }

  return {
    usage,
    usageKind,
    effort,
    sourceDevice: metadata.dev,
    sourceInode: metadata.ino,
    sourceSizeBytes: metadata.size,
    sourceMtimeMs: mtimeMs,
    sourceOffsetBytes: offset,
  };
}

async function readForward(
  path: string,
  start: number,
  size: number,
  provider: Provider,
): Promise<{ usage: UsageSnapshot | null; usageKind: ParsedSource["usageKind"]; effort: string | null; offset: number }> {
  if (start === size) return { usage: null, usageKind: null, effort: null, offset: start };
  const file = await open(path, "r");
  try {
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    const data = buffer.subarray(0, bytesRead);
    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline < 0) return { usage: null, usageKind: null, effort: null, offset: start };
    const lines = data.subarray(0, lastNewline + 1).toString("utf8").split("\n");
    return {
      ...findLatestUsage(lines, provider),
      offset: start + lastNewline + 1,
    };
  } finally {
    await file.close();
  }
}

async function reverseTail(
  path: string,
  size: number,
  provider: Provider,
): Promise<{ usage: UsageSnapshot | null; usageKind: ParsedSource["usageKind"]; effort: string | null; offset: number }> {
  if (size === 0) return { usage: null, usageKind: null, effort: null, offset: 0 };
  const file = await open(path, "r");
  try {
    let length = Math.min(size, INITIAL_TAIL_BYTES);
    while (true) {
      const start = size - length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      let data = buffer.subarray(0, bytesRead);
      if (start > 0) {
        const firstNewline = data.indexOf(0x0a);
        data = firstNewline >= 0 ? data.subarray(firstNewline + 1) : Buffer.alloc(0);
      }
      const found = findLatestUsage(data.toString("utf8").split("\n"), provider);
      if (found.usage || length === size || length >= MAX_REVERSE_TAIL_BYTES) {
        const finalNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
        return {
          ...found,
          offset: finalNewline >= 0 ? start + finalNewline + 1 : 0,
        };
      }
      length = Math.min(size, length * 2);
    }
  } finally {
    await file.close();
  }
}

function findLatestUsage(
  lines: string[],
  provider: Provider,
): { usage: UsageSnapshot | null; usageKind: ParsedSource["usageKind"]; effort: string | null } {
  let latestUsage: UsageSnapshot | null = null;
  let latestUsageKind: ParsedSource["usageKind"] = null;
  let effort: string | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      effort ??= recordEffort(value);
      const usage = provider === "codex" ? parseCodex(value) : parseClaude(value);
      if (usage && latestUsage === null) {
        const usageKind = provider === "claude" && isClaudeCheckpoint(value)
          ? "checkpoint"
          : "invocation";
        latestUsage = usage;
        latestUsageKind = usageKind;
      }
    } catch {
      // A concurrently appended or provider-specific line is ignored. The cursor
      // advances only through complete newline-delimited records.
    }
  }
  return { usage: latestUsage, usageKind: latestUsageKind, effort };
}

function recordEffort(record: Record<string, unknown>): string | null {
  const payload = object(record.payload);
  const message = object(record.message);
  for (const value of [
    record.effort,
    record.reasoning_effort,
    payload?.effort,
    payload?.reasoning_effort,
    payload?.model_reasoning_effort,
    message?.effort,
    message?.reasoning_effort,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isClaudeCheckpoint(record: Record<string, unknown>): boolean {
  return record.type === "system" && record.subtype === "compact_boundary";
}

function parseCodex(record: Record<string, unknown>): UsageSnapshot | null {
  if (record.type !== "event_msg") return null;
  const payload = object(record.payload);
  if (payload?.type !== "token_count") return null;
  const info = object(payload.info);
  const usage = object(info?.last_token_usage);
  if (!info || !usage) return null;

  const timestamp = timestampMs(record.timestamp);
  // Codex input_tokens is already the inclusive input total. Cached and
  // cache-write tokens are subsets, so adding them would double count.
  const inputTotal = number(usage.input_tokens);
  const output = number(usage.output_tokens);
  if (timestamp === null || inputTotal === null || output === null) return null;
  const total = number(usage.total_tokens);
  const normalizedInputTotal =
    inputTotal === 0 && output === 0 && total !== null && total > 0 ? total : inputTotal;

  return {
    usageEventAtMs: timestamp,
    model: null,
    speed: null,
    inputTokensTotal: normalizedInputTotal,
    inputTokensCached: number(usage.cached_input_tokens) ?? 0,
    inputTokensCacheWrite: number(usage.cache_write_input_tokens) ?? 0,
    outputTokens: output,
    contextWindowTokens: number(info.model_context_window),
  };
}

function parseClaude(record: Record<string, unknown>): UsageSnapshot | null {
  if (record.type === "system" && record.subtype === "compact_boundary") {
    const metadata = object(record.compactMetadata);
    const timestamp = timestampMs(record.timestamp);
    const postTokens = number(metadata?.postTokens);
    if (timestamp === null || postTokens === null) return null;
    return {
      usageEventAtMs: timestamp,
      model: null,
      speed: null,
      inputTokensTotal: postTokens,
      inputTokensCached: 0,
      inputTokensCacheWrite: 0,
      outputTokens: 0,
      contextWindowTokens: null,
    };
  }

  if (record.type !== "assistant" || record.isSidechain === true) return null;
  const message = object(record.message);
  const usage = object(message?.usage);
  if (!message || !usage) return null;

  const timestamp = timestampMs(record.timestamp);
  // Claude reports three disjoint input buckets, unlike Codex's inclusive
  // input_tokens, so its normalized total must sum them exactly once.
  const uncached = number(usage.input_tokens);
  const cached = number(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = number(usage.cache_creation_input_tokens) ?? 0;
  const output = number(usage.output_tokens);
  if (timestamp === null || uncached === null || output === null) return null;

  return {
    usageEventAtMs: timestamp,
    model: typeof message.model === "string" ? message.model : null,
    speed: usage.speed === "fast" ? "fast" : "standard",
    inputTokensTotal: uncached + cached + cacheWrite,
    inputTokensCached: cached,
    inputTokensCacheWrite: cacheWrite,
    outputTokens: output,
    contextWindowTokens: null,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
