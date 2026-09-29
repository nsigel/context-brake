import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { completeWithDeepSeek } from "./bedrock.js";
import { compact } from "./compact.js";
import { loadConfig } from "./config.js";
import type { CompactionRequest, CompactionResponse } from "./contract.js";
import { logger } from "./logger.js";
import { readCompactionRequest, RequestError } from "./request.js";
import { COMPACTION_SYSTEM_PROMPT } from "./prompt.js";

export type RunCompaction = (
  request: CompactionRequest,
) => Promise<CompactionResponse>;

export interface AppOptions {
  runCompaction: RunCompaction;
  hostname?: string;
  port?: number;
  modelId?: string;
  awsRegion?: string;
  maximumOutputTokens?: number;
  inputUsdPerMillion?: number | null;
  outputUsdPerMillion?: number | null;
}

export interface App {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  stop: () => Promise<void>;
}

export function createApp(options: AppOptions): App {
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 7790,
    async fetch(request, bunServer) {
      const startedAt = performance.now();
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/v1/compactions") {
        bunServer.timeout(request, 120);
      }
      const requestId =
        request.headers.get("x-request-id") ?? crypto.randomUUID();
      const requestLogger = logger.child({
        requestId,
        method: request.method,
        path,
      });

      const response = await route(request, requestLogger, options);
      response.headers.set("x-request-id", requestId);
      requestLogger.info(
        {
          statusCode: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        },
        "request completed",
      );
      return response;
    },
  });

  return {
    server,
    url: server.url.toString(),
    stop: () => server.stop(),
  };
}

async function route(
  request: Request,
  requestLogger: Logger,
  options: AppOptions,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/healthz") {
    return json(200, {
      ok: true,
      model: options.modelId ?? null,
      region: options.awsRegion ?? null,
      maximumOutputTokens: options.maximumOutputTokens ?? null,
      inputUsdPerMillion: options.inputUsdPerMillion ?? null,
      outputUsdPerMillion: options.outputUsdPerMillion ?? null,
      systemPromptSha256: createHash("sha256")
        .update(COMPACTION_SYSTEM_PROMPT.trimEnd())
        .digest("hex"),
    });
  }
  if (request.method !== "POST" || path !== "/v1/compactions") {
    return json(404, { error: "not_found" });
  }

  try {
    const input = await readCompactionRequest(request);
    const result = await options.runCompaction(input);
    const costUsd = compactionCost(result, options);
    requestLogger.info(
      {
        chunks: input.chunks.length,
        invocations: result.usage.invocations,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningReceived: result.usage.reasoningCharacters > 0,
        reasoningCharacters: result.usage.reasoningCharacters,
      },
      "compaction completed",
    );
    return json(200, { ...result, costUsd });
  } catch (error) {
    if (error instanceof RequestError) {
      return json(error.status, { error: error.code });
    }
    requestLogger.error({ err: error }, "compaction failed");
    return json(502, { error: "compaction_failed" });
  }
}

function compactionCost(
  result: CompactionResponse,
  options: AppOptions,
): number | null {
  if (options.inputUsdPerMillion == null || options.outputUsdPerMillion == null) return null;
  return (
    (result.usage.inputTokens / 1_000_000) * options.inputUsdPerMillion +
    (result.usage.outputTokens / 1_000_000) * options.outputUsdPerMillion
  );
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const sts = new STSClient({ region: config.awsRegion });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  logger.info(
    {
      account: identity.Account,
      arn: identity.Arn,
      region: config.awsRegion,
      model: config.modelId,
    },
    "AWS identity loaded",
  );

  const complete = completeWithDeepSeek(sts.config.credentials, {
    awsRegion: config.awsRegion,
    modelId: config.modelId,
    maximumOutputTokens: config.maximumOutputTokens,
  });
  const app = createApp({
    runCompaction: (request) => compact(request, complete),
    hostname: config.hostname,
    port: config.port,
    modelId: config.modelId,
    awsRegion: config.awsRegion,
    maximumOutputTokens: config.maximumOutputTokens,
    inputUsdPerMillion: config.inputUsdPerMillion,
    outputUsdPerMillion: config.outputUsdPerMillion,
  });
  logger.info({ url: app.url }, "compaction server started");

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "compaction server stopping");
    await app.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (import.meta.main) {
  await main();
}
