import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ThreadStore } from "./db.js";
import { PARSER_VERSION, readLatestTranscriptUsage } from "./parsers.js";
import { findModelPolicy, type BrakePolicy } from "./policy.js";
import type { Evaluation, HookInput, Provider, SavingsEstimate, ThreadRow } from "./types.js";

const STALE_RETRY_WINDOW_MS = 10 * 60 * 1000;

interface StaleRetry {
  usageEventAtMs: number;
  armedAtMs: number;
  blockedTurnId?: string;
  bypassTurnId?: string;
}

export class JitEvaluator {
  private readonly staleRetries = new Map<string, StaleRetry>();

  constructor(
    private readonly store: ThreadStore,
    private readonly policy: BrakePolicy,
    private readonly now: () => number = Date.now,
  ) {}

  async evaluate(provider: Provider, input: HookInput): Promise<Evaluation> {
    if (!input.session_id) return { action: "continue" };

    const existing = this.store.find(provider, input.session_id);
    if (!input.transcript_path) return { action: "continue" };
    const transcriptPath = expandHome(input.transcript_path);
    if (!existsSync(transcriptPath)) return { action: "continue" };

    let parsed;
    try {
      parsed = await readLatestTranscriptUsage(provider, transcriptPath, existing);
    } catch (error) {
      return { action: "continue", error };
    }

    const observedModel = parsed.usage?.model ?? existing?.model ?? null;
    const changedToModel =
      input.model !== undefined && observedModel !== null && input.model !== observedModel
        ? input.model
        : null;
    const model = changedToModel === null ? input.model ?? observedModel : observedModel;
    const modelPolicy = model ? findModelPolicy(this.policy, provider, model) : null;
    const normalizedUsage = parsed.usage
      ? {
          ...parsed.usage,
          model: parsed.usage.model ?? model,
          contextWindowTokens:
            parsed.usage.contextWindowTokens ?? modelPolicy?.contextWindowTokens ?? null,
        }
      : null;
    const saved = this.store.upsert({
      provider,
      threadId: input.session_id,
      transcriptPath,
      title: existing?.title ?? null,
      cwd: input.cwd ?? existing?.cwd ?? null,
      model,
      effort: input.effort ?? parsed.effort ?? existing?.effort ?? null,
      usage: normalizedUsage,
      usageKind: parsed.usageKind,
      sourceDevice: parsed.sourceDevice,
      sourceInode: parsed.sourceInode,
      sourceSizeBytes: parsed.sourceSizeBytes,
      sourceMtimeMs: parsed.sourceMtimeMs,
      sourceOffsetBytes: parsed.sourceOffsetBytes,
      parserVersion: PARSER_VERSION,
      checkedAtMs: this.now(),
    });

    if (changedToModel !== null) {
      return {
        action: "block",
        reason: `Context Brake: changing this thread from ${observedModel} to ${changedToModel} would rebuild its prompt cache. Start a new thread or hand off the current context before changing models.`,
        model: changedToModel,
        speed: saved.speed,
      };
    }

    const retryKey = `${provider}:${input.session_id}`;
    const retry = this.staleRetries.get(retryKey);
    if (
      retry !== undefined &&
      (retry.usageEventAtMs !== saved.usageEventAtMs ||
        this.now() - retry.armedAtMs > STALE_RETRY_WINDOW_MS)
    ) {
      this.staleRetries.delete(retryKey);
    }

    const isPromptSubmit =
      input.hook_event_name === undefined || input.hook_event_name === "UserPromptSubmit";
    return this.decide(saved, input.prompt ?? "", isPromptSubmit, input.turn_id);
  }

  estimateSavings(thread: ThreadRow): SavingsEstimate | null {
    if (
      thread.inputTokensTotal === null ||
      thread.outputTokens === null ||
      !thread.model
    ) {
      return null;
    }

    const modelPolicy = findModelPolicy(this.policy, thread.provider, thread.model);
    if (!modelPolicy) return null;
    const pricing = thread.speed === "fast" && modelPolicy.fast ? modelPolicy.fast : modelPolicy;
    const estimatedContextTokens = thread.inputTokensTotal + thread.outputTokens;
    const estimatedHandoffTokens = this.policy.estimatedHandoffTokens;
    const estimatedAvoidedTokens = Math.max(0, estimatedContextTokens - estimatedHandoffTokens);
    return {
      estimatedContextTokens,
      estimatedHandoffTokens,
      estimatedAvoidedTokens,
      estimatedSavingsUsd: (estimatedAvoidedTokens / 1_000_000) * pricing.cacheWriteUsdPerMillion,
    };
  }

  private decide(
    thread: ThreadRow,
    prompt: string,
    isPromptSubmit: boolean,
    turnId?: string,
  ): Evaluation {
    if (
      thread.usageEventAtMs === null ||
      thread.inputTokensTotal === null ||
      thread.outputTokens === null ||
      !thread.model
    ) {
      return { action: "continue" };
    }

    const modelPolicy = findModelPolicy(this.policy, thread.provider, thread.model);
    if (!modelPolicy) {
      return { action: "continue", model: thread.model, speed: thread.speed };
    }
    const pricing = thread.speed === "fast" && modelPolicy.fast ? modelPolicy.fast : modelPolicy;

    const cacheAgeMs = Math.max(0, this.now() - thread.usageEventAtMs);
    const promptTokens = Math.ceil(prompt.length / this.policy.promptCharactersPerToken);
    const estimatedContextTokens = thread.inputTokensTotal + thread.outputTokens + promptTokens;
    const avoidedTokens = Math.max(0, estimatedContextTokens - this.policy.estimatedHandoffTokens);
    const savingsUsd = (avoidedTokens / 1_000_000) * pricing.cacheWriteUsdPerMillion;
    const decisionInputs = {
      model: thread.model,
      speed: thread.speed,
      cacheAgeMs,
      cacheTtlMs: modelPolicy.cacheTtlMs,
      estimatedContextTokens,
      estimatedHandoffTokens: this.policy.estimatedHandoffTokens,
      estimatedAvoidedTokens: avoidedTokens,
      cacheWriteUsdPerMillion: pricing.cacheWriteUsdPerMillion,
      estimatedSavingsUsd: savingsUsd,
      minimumSavingsUsd: this.policy.minimumSavingsUsd,
    };

    if (cacheAgeMs <= modelPolicy.cacheTtlMs) {
      return { action: "continue", ...decisionInputs };
    }

    if (avoidedTokens === 0 || savingsUsd < this.policy.minimumSavingsUsd) {
      return { action: "continue", ...decisionInputs };
    }

    const reason = [
      "Context Brake: this thread's prompt cache is likely stale.",
      `The last model usage was ${formatAge(cacheAgeMs)} ago.`,
      `Continuing would send approximately ${formatInteger(estimatedContextTokens)} input-context tokens.`,
      `An estimated ${formatInteger(this.policy.estimatedHandoffTokens)}-token handoff would avoid approximately ${formatInteger(avoidedTokens)} tokens on the next request, saving about ${formatUsd(savingsUsd)} before compaction cost.`,
      "Resubmit the prompt to continue this thread.",
    ].join(" ") + `\n\nTo continue in a new chat, run: context-brake relay ${thread.threadId}`;

    if (!isPromptSubmit) return { action: "continue", ...decisionInputs };

    const retryKey = `${thread.provider}:${thread.threadId}`;
    const retry = this.staleRetries.get(retryKey);
    if (
      retry !== undefined &&
      retry.usageEventAtMs === thread.usageEventAtMs &&
      this.now() - retry.armedAtMs <= STALE_RETRY_WINDOW_MS
    ) {
      if (turnId !== undefined) {
        if (retry.blockedTurnId === turnId) {
          return { action: "block", reason, ...decisionInputs };
        }
        if (retry.bypassTurnId === turnId) {
          return { action: "continue", ...decisionInputs };
        }
        if (retry.bypassTurnId === undefined) {
          retry.bypassTurnId = turnId;
          return { action: "continue", ...decisionInputs };
        }
        this.staleRetries.delete(retryKey);
      } else {
        this.staleRetries.delete(retryKey);
        return { action: "continue", ...decisionInputs };
      }
    }
    this.staleRetries.set(retryKey, {
      usageEventAtMs: thread.usageEventAtMs,
      armedAtMs: this.now(),
      ...(turnId === undefined ? {} : { blockedTurnId: turnId }),
    });
    return { action: "block", reason, ...decisionInputs };
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function formatAge(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${hours}h ${remainder}m`;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.1 ? 3 : 2,
    maximumFractionDigits: value < 0.1 ? 3 : 2,
  }).format(value);
}
