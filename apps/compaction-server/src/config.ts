export interface ServerConfig {
  hostname: string;
  port: number;
  awsRegion: string;
  modelId: string;
  maximumOutputTokens: number;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): ServerConfig {
  const awsRegion = env.COMPACTION_AWS_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
  const modelId = env.COMPACTION_MODEL_ID ?? "deepseek.v3.2";
  const defaults = defaultPricing(modelId, awsRegion);
  return {
    hostname: env.COMPACTION_HOST ?? "127.0.0.1",
    port: positiveInteger(env.COMPACTION_PORT, 7790, "COMPACTION_PORT"),
    awsRegion,
    modelId,
    maximumOutputTokens: positiveInteger(
      env.COMPACTION_MAX_OUTPUT_TOKENS,
      8_000,
      "COMPACTION_MAX_OUTPUT_TOKENS",
    ),
    inputUsdPerMillion: optionalNumber(
      env.COMPACTION_INPUT_USD_PER_MILLION,
      defaults?.inputUsdPerMillion ?? null,
      "COMPACTION_INPUT_USD_PER_MILLION",
    ),
    outputUsdPerMillion: optionalNumber(
      env.COMPACTION_OUTPUT_USD_PER_MILLION,
      defaults?.outputUsdPerMillion ?? null,
      "COMPACTION_OUTPUT_USD_PER_MILLION",
    ),
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function optionalNumber(value: string | undefined, fallback: number | null, name: string): number | null {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function defaultPricing(
  modelId: string,
  region: string,
): { inputUsdPerMillion: number; outputUsdPerMillion: number } | null {
  if (modelId !== "deepseek.v3.2") return null;
  if (["us-east-1", "us-east-2", "us-west-2"].includes(region)) {
    return { inputUsdPerMillion: 0.62, outputUsdPerMillion: 1.85 };
  }
  return null;
}
