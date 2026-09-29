import type { ModelPolicy, ModelPricing, Provider } from "./types.js";

const HOUR = 60 * 60 * 1000;
const FAST_OPUS: ModelPricing = {
  inputUsdPerMillion: 10,
  cachedInputUsdPerMillion: 1,
  cacheWriteUsdPerMillion: 20,
  outputUsdPerMillion: 50,
};

// Pricing is kept out of SQLite deliberately: it is mutable application policy.
// These defaults are versioned with the service and can be overridden through
// CONTEXT_BRAKE_POLICY_JSON without rewriting thread rows.
const DEFAULT_POLICIES: Record<Provider, ModelPolicy[]> = {
  codex: [
    policy(/^gpt-5\.6(?:-sol)?$/, 5, 0.5, 6.25, 30, 1_050_000),
    policy(/^gpt-5\.6-terra$/, 2.5, 0.25, 3.125, 15, 1_050_000),
    policy(/^gpt-5\.6-luna$/, 1, 0.1, 1.25, 6, 1_050_000),
  ],
  claude: [
    policy(/^claude-fable-5(?:-|$)/, 10, 1, 20, 50, 1_000_000),
    policy(/^claude-opus-5(?:-|$)/, 5, 0.5, 10, 25, 1_000_000, FAST_OPUS),
    policy(/^claude-opus-4[-.]8(?:-|$)/, 5, 0.5, 10, 25, 1_000_000, FAST_OPUS),
    policy(/^claude-opus-4[-.]7(?:-|$)/, 5, 0.5, 10, 25, 1_000_000),
    policy(/^claude-opus-4[-.]6(?:-|$)/, 5, 0.5, 10, 25, 1_000_000),
    policy(/^claude-opus-4[-.]5(?:-|$)/, 5, 0.5, 10, 25, 200_000),
    policy(/^claude-opus-4[-.]1(?:-|$)/, 15, 1.5, 30, 75, 200_000),
    policy(/^claude-opus-4(?:-|$)/, 15, 1.5, 30, 75, 200_000),
    policy(/^claude-sonnet-5(?:-|$)/, 2, 0.2, 4, 10, 1_000_000),
    policy(/^claude-sonnet-4[-.]6(?:-|$)/, 3, 0.3, 6, 15, 1_000_000),
    policy(/^claude-sonnet-4[-.]5(?:-|$)/, 3, 0.3, 6, 15, 200_000),
    policy(/^claude-sonnet-4(?:-|$)/, 3, 0.3, 6, 15, 200_000),
    policy(/^claude-haiku-4[-.]5(?:-|$)/, 1, 0.1, 2, 5, 200_000),
    policy(/^(?:claude-haiku-3[-.]5|claude-3[-.]5-haiku)(?:-|$)/, 0.8, 0.08, 1.6, 4, 200_000),
  ],
};

function policy(
  pattern: RegExp,
  input: number,
  cached: number,
  cacheWrite: number,
  output: number,
  contextWindow: number,
  fast?: ModelPricing,
): ModelPolicy {
  return {
    pattern,
    cacheTtlMs: HOUR,
    inputUsdPerMillion: input,
    cachedInputUsdPerMillion: cached,
    cacheWriteUsdPerMillion: cacheWrite,
    outputUsdPerMillion: output,
    contextWindowTokens: contextWindow,
    ...(fast ? { fast } : {}),
  };
}

export interface BrakePolicy {
  estimatedHandoffTokens: number;
  minimumSavingsUsd: number;
  promptCharactersPerToken: number;
  models: Record<Provider, ModelPolicy[]>;
}

export function loadPolicy(): BrakePolicy {
  const base: BrakePolicy = {
    estimatedHandoffTokens: numberEnv("CONTEXT_BRAKE_HANDOFF_TOKENS", 8_000),
    minimumSavingsUsd: numberEnv("CONTEXT_BRAKE_MIN_SAVINGS_USD", 0.05),
    promptCharactersPerToken: numberEnv("CONTEXT_BRAKE_CHARS_PER_TOKEN", 4),
    models: DEFAULT_POLICIES,
  };

  const override = Bun.env.CONTEXT_BRAKE_POLICY_JSON;
  if (!override) return base;
  const parsed = JSON.parse(override) as {
    estimatedHandoffTokens?: number;
    minimumSavingsUsd?: number;
    promptCharactersPerToken?: number;
  };
  return {
    ...base,
    ...parsed,
    models: base.models,
  };
}

export function findModelPolicy(
  policy: BrakePolicy,
  provider: Provider,
  model: string,
): ModelPolicy | null {
  return policy.models[provider].find((candidate) => candidate.pattern.test(model)) ?? null;
}

function numberEnv(name: string, fallback: number): number {
  const value = Bun.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}
