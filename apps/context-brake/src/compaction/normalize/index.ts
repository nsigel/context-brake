import { normalizeClaude } from "./claude.js";
import { normalizeCodex } from "./codex.js";
import type { NormalizedEvent } from "./types.js";

export type TranscriptProvider = "codex" | "claude";

export function normalizeTranscript(raw: string, provider: TranscriptProvider): NormalizedEvent[] {
  return provider === "codex" ? normalizeCodex(raw) : normalizeClaude(raw);
}

export { normalizeCodex, normalizeClaude };
export type { NormalizedEvent, NormalizedToolEvent } from "./types.js";
