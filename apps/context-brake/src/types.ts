export type Provider = "codex" | "claude";
export type UsageSpeed = "standard" | "fast";
export type ThreadState = "active" | "closed";

export interface HookInput {
  session_id: string;
  hook_event_name?: string;
  reason?: string;
  transcript_path?: string | null;
  cwd?: string;
  model?: string;
  effort?: string;
  prompt?: string;
  turn_id?: string;
}

export interface UsageSnapshot {
  usageEventAtMs: number;
  model: string | null;
  speed: UsageSpeed | null;
  /** All input context tokens, including the cached and cache-write subsets below. */
  inputTokensTotal: number;
  /** Cache-read tokens included in inputTokensTotal. */
  inputTokensCached: number;
  /** Cache-write tokens included in inputTokensTotal. */
  inputTokensCacheWrite: number;
  outputTokens: number;
  contextWindowTokens: number | null;
}

export interface ThreadRow {
  provider: Provider;
  threadId: string;
  state: ThreadState;
  transcriptPath: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  speed: UsageSpeed | null;
  usageEventAtMs: number | null;
  inputTokensTotal: number | null;
  inputTokensCached: number | null;
  inputTokensCacheWrite: number | null;
  outputTokens: number | null;
  contextWindowTokens: number | null;
  sourceDevice: number | null;
  sourceInode: number | null;
  sourceSizeBytes: number | null;
  sourceMtimeMs: number | null;
  sourceOffsetBytes: number | null;
  parserVersion: number | null;
  checkedAtMs: number | null;
}

export interface ModelPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface ModelPolicy extends ModelPricing {
  pattern: RegExp;
  cacheTtlMs: number;
  contextWindowTokens: number;
  fast?: ModelPricing;
}

export interface Evaluation {
  action: "continue" | "block";
  /** The real evaluation failure when the service deliberately fails open. */
  error?: unknown;
  reason?: string;
  model?: string;
  speed?: UsageSpeed | null;
  cacheAgeMs?: number;
  cacheTtlMs?: number;
  estimatedContextTokens?: number;
  estimatedHandoffTokens?: number;
  cacheWriteUsdPerMillion?: number;
  estimatedSavingsUsd?: number;
  minimumSavingsUsd?: number;
  estimatedAvoidedTokens?: number;
}

export interface SavingsEstimate {
  estimatedContextTokens: number;
  estimatedHandoffTokens: number;
  estimatedAvoidedTokens: number;
  estimatedSavingsUsd: number;
}
