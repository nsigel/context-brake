import { readFile } from "node:fs/promises";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Logger } from "pino";
import { prepareCompaction } from "./compaction/prepare.js";
import { ThreadStore } from "./db.js";
import { JitEvaluator } from "./evaluator.js";
import { logBuffer, logger } from "./logger.js";
import { type BrakePolicy, loadPolicy } from "./policy.js";
import { readHookInput } from "./request.js";
import type { Provider, SavingsEstimate, ThreadRow } from "./types.js";

interface AppContext {
  store: ThreadStore;
  evaluator: JitEvaluator;
  status: ServerStatus;
  compactionServerUrl: URL;
}

export interface ServerStatus {
  ok: true;
  service: "context-brake";
  url: string;
  host: string;
  port: number;
  pid: number;
  startedAt: string;
}

export interface AppOptions {
  now?: () => number;
  policy?: BrakePolicy;
  databasePath?: string;
  hostname?: string;
  port?: number;
  compactionServerUrl?: string;
}

export interface App {
  server: ReturnType<typeof Bun.serve>;
  store: ThreadStore;
  status: ServerStatus;
  url: string;
  stop: () => Promise<void>;
}

// Wiring is a factory so tests can boot a real server with a frozen clock,
// fixed pricing, an ephemeral port, and a throwaway database.
export function createApp(options: AppOptions = {}): App {
  const databasePath = resolve(
    options.databasePath ?? Bun.env.CONTEXT_BRAKE_DB_PATH ?? join("data", "context-brake.sqlite"),
  );
  const store = new ThreadStore(databasePath);
  const policy = options.policy ?? loadPolicy();
  const evaluator = new JitEvaluator(store, policy, options.now);
  const compactionServerUrl = new URL(
    options.compactionServerUrl ??
      Bun.env.CONTEXT_BRAKE_COMPACTION_URL ??
      "http://127.0.0.1:7790",
  );
  const startedAt = new Date().toISOString();
  let context: AppContext;

  const server = Bun.serve({
    hostname: options.hostname ?? Bun.env.CONTEXT_BRAKE_HOST ?? "127.0.0.1",
    port: options.port ?? Number(Bun.env.CONTEXT_BRAKE_PORT ?? "7788"),
    async fetch(request, bunServer) {
      const startedAt = performance.now();
      const path = new URL(request.url).pathname;
      if (
        request.method === "POST" &&
        (path === "/v1/compact" || path.startsWith("/v1/relay/"))
      ) {
        bunServer.timeout(request, 120);
      }
      const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
      const requestLogger = logger.child({ requestId, method: request.method, path });

      let response: Response;
      try {
        response = await route(request, requestLogger, context);
      } catch (error) {
        requestLogger.error({ err: error }, "request failed; failing open");
        response = noContent();
      }

      response.headers.set("x-request-id", requestId);
      const requestCompleted = {
        statusCode: response.status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
      if (path === "/healthz") {
        requestLogger.debug(requestCompleted, "request completed");
      } else {
        requestLogger.info(requestCompleted, "request completed");
      }
      return response;
    },
  });

  const status = makeServerStatus(server.url.toString(), startedAt);
  context = { store, evaluator, status, compactionServerUrl };

  return {
    server,
    store,
    status,
    url: server.url.toString(),
    stop: async () => {
      await server.stop();
      store.close();
    },
  };
}

async function route(request: Request, requestLogger: Logger, context: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/healthz") {
    return json(200, context.status);
  }

  if (request.method === "GET" && path === "/v1/compaction/healthz") {
    return compactionHealth(context);
  }

  if (request.method === "GET" && path === "/v1/threads") {
    return json(200, context.store.listActive().map((thread) => visualize(thread, context.evaluator.estimateSavings(thread))));
  }

  if (request.method === "POST" && path === "/v1/compact") {
    const url = new URL(request.url);
    const providerValue = url.searchParams.get("provider");
    const threadId = url.searchParams.get("thread_id");
    if (
      (providerValue !== "codex" && providerValue !== "claude") ||
      !threadId ||
      threadId.length > 512
    ) {
      return json(400, { error: "invalid_compaction_target" });
    }
    return compactThread(providerValue, threadId, context, requestLogger);
  }

  const relayMatch = path.match(/^\/v1\/relay\/([^/]+)$/);
  if (request.method === "POST" && relayMatch) {
    let threadId = "";
    try {
      threadId = decodeURIComponent(relayMatch[1] ?? "");
    } catch {
      return json(400, { error: "invalid_relay_id" });
    }
    if (!threadId || threadId.length > 512) {
      return json(400, { error: "invalid_relay_id" });
    }
    const thread = context.store.findByThreadId(threadId);
    if (!thread) return json(404, { error: "relay_not_found" });
    return relayThread(thread, context, requestLogger);
  }

  if (request.method === "GET" && path === "/v1/logs") {
    return new Response(logBuffer.snapshot(), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/x-ndjson; charset=utf-8",
      },
    });
  }

  const match = path.match(/^\/v1\/hooks\/(codex|claude)$/);
  if (request.method === "POST" && match) {
    const provider = match[1] as Provider;
    const input = await readHookInput(request);
    if (input.hook_event_name === "SessionEnd") {
      context.store.closeThread(provider, input.session_id, Date.now());
      requestLogger.info(
        { event: "thread_closed", provider, threadId: input.session_id, reason: input.reason },
        "thread closed",
      );
      return noContent();
    }
    const evaluation = await context.evaluator.evaluate(provider, input);
    if (evaluation.error !== undefined) {
      requestLogger.warn(
        { err: evaluation.error, provider, threadId: input.session_id },
        "context brake evaluation failed; failing open",
      );
    }
    // Lifecycle hooks refresh the row but must never turn a Stop into an auto-continuation.
    const shouldEnforce =
      input.hook_event_name === undefined || input.hook_event_name === "UserPromptSubmit";
    requestLogger.info(
      {
        event: "brake_decision",
        provider,
        threadId: input.session_id,
        hookEventName: input.hook_event_name,
        turnId: input.turn_id,
        action: evaluation.action,
        model: evaluation.model,
        speed: evaluation.speed,
        cacheAgeMs: evaluation.cacheAgeMs,
        cacheTtlMs: evaluation.cacheTtlMs,
        estimatedContextTokens: evaluation.estimatedContextTokens,
        estimatedHandoffTokens: evaluation.estimatedHandoffTokens,
        estimatedAvoidedTokens: evaluation.estimatedAvoidedTokens,
        cacheWriteUsdPerMillion: evaluation.cacheWriteUsdPerMillion,
        estimatedSavingsUsd: evaluation.estimatedSavingsUsd,
        minimumSavingsUsd: evaluation.minimumSavingsUsd,
      },
      "context brake decision",
    );
    if (!shouldEnforce || evaluation.action === "continue") {
      return noContent();
    }
    return json(200, { decision: "block", reason: evaluation.reason });
  }

  return json(404, { error: "not_found" });
}

async function compactionHealth(context: AppContext): Promise<Response> {
  try {
    const response = await fetch(new URL("/healthz", context.compactionServerUrl), {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return json(503, { ok: false, error: "compaction_server_unavailable" });
    const body: unknown = await response.json();
    return isObject(body) && body.ok === true
      ? json(200, body)
      : json(503, { ok: false, error: "invalid_compaction_server_health" });
  } catch {
    return json(503, { ok: false, error: "compaction_server_unavailable" });
  }
}

async function compactThread(
  provider: "codex" | "claude",
  threadId: string,
  context: AppContext,
  requestLogger: Logger,
): Promise<Response> {
  const thread = context.store.find(provider, threadId);
  if (!thread) return json(404, { error: "thread_not_found" });

  const result = await compactStoredThread(thread, context, requestLogger);
  return json(result.status, result.body);
}

function relayThread(
  thread: ThreadRow,
  context: AppContext,
  requestLogger: Logger,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        const result = await compactStoredThread(thread, context, requestLogger, (stage) => {
          send({ stage });
        });
        if (result.status !== 200 || typeof result.body.summary !== "string") {
          send({ error: result.body.error ?? "relay_failed" });
          return;
        }
        send({
          stage: "ready",
          provider: thread.provider,
          cwd: thread.cwd,
          model: thread.model,
          effort: thread.effort,
          summary: result.body.summary,
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
}

async function compactStoredThread(
  thread: ThreadRow,
  context: AppContext,
  requestLogger: Logger,
  onStage?: (stage: "normalizing" | "reducing" | "compacting") => void,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { provider, threadId } = thread;

  try {
    const request = prepareCompaction(await readFile(thread.transcriptPath, "utf8"), provider, {
      ...(onStage ? { onStage } : {}),
    });
    if (request.chunks.length === 0) return { status: 422, body: { error: "empty_compaction" } };

    onStage?.("compacting");
    const response = await fetch(new URL("/v1/compactions", context.compactionServerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      requestLogger.warn({ statusCode: response.status, provider, threadId }, "compaction server rejected request");
      return { status: 502, body: { error: "compaction_failed" } };
    }

    const body: unknown = await response.json();
    if (!isObject(body) || typeof body.summary !== "string" || !isObject(body.usage)) {
      return { status: 502, body: { error: "invalid_compaction_response" } };
    }
    const estimate = context.evaluator.estimateSavings(thread);
    const compactionCostUsd = finiteNumber(body.costUsd);
    return {
      status: 200,
      body: {
        ...body,
        estimatedSavingsUsd: estimate?.estimatedSavingsUsd ?? null,
        estimatedAvoidedTokens: estimate?.estimatedAvoidedTokens ?? null,
        estimatedHandoffTokens: estimate?.estimatedHandoffTokens ?? null,
        compactionCostUsd,
        netSavingsUsd:
          estimate && compactionCostUsd !== null
            ? estimate.estimatedSavingsUsd - compactionCostUsd
            : null,
      },
    };
  } catch (error) {
    requestLogger.error({ err: error, provider, threadId }, "compaction failed");
    return { status: 502, body: { error: "compaction_server_unavailable" } };
  }
}

function visualize(thread: ThreadRow, estimate: SavingsEstimate | null): Record<string, unknown> {
  const contextTokens =
    thread.inputTokensTotal === null || thread.outputTokens === null
      ? null
      : thread.inputTokensTotal + thread.outputTokens;
  const pressure =
    contextTokens === null || !thread.contextWindowTokens
      ? null
      : Math.round((contextTokens / thread.contextWindowTokens) * 1_000) / 10;
  return {
    ...thread,
    contextTokens,
    contextPressurePercent: pressure,
    cacheAgeMs: thread.usageEventAtMs === null ? null : Math.max(0, Date.now() - thread.usageEventAtMs),
    estimatedContextTokens: estimate?.estimatedContextTokens ?? null,
    estimatedHandoffTokens: estimate?.estimatedHandoffTokens ?? null,
    estimatedAvoidedTokens: estimate?.estimatedAvoidedTokens ?? null,
    estimatedSavingsUsd: estimate?.estimatedSavingsUsd ?? null,
  };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function makeServerStatus(url: string, startedAt: string): ServerStatus {
  const parsedURL = new URL(url);
  return {
    ok: true,
    service: "context-brake",
    url,
    host: parsedURL.hostname,
    port: Number(parsedURL.port),
    pid: process.pid,
    startedAt,
  };
}

function writeReadyFile(path: string, status: ServerStatus): void {
  const readyPath = resolve(path);
  mkdirSync(dirname(readyPath), { recursive: true });
  const temporaryPath = `${readyPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, readyPath);
}

function removeReadyFile(path: string): void {
  try {
    unlinkSync(resolve(path));
  } catch {
    // The file may already be gone after an interrupted startup.
  }
}

// Only bind the port, install signal handlers, and log when run directly
// (bun run dev from this app). Importing the module in tests must have no effect.
if (import.meta.main) {
  const app = createApp();
  const readyFile = Bun.env.CONTEXT_BRAKE_READY_FILE;
  if (readyFile) writeReadyFile(readyFile, app.status);
  logger.info({ url: app.url, databasePath: resolve(Bun.env.CONTEXT_BRAKE_DB_PATH ?? join("data", "context-brake.sqlite")) }, "server started");

  let isShuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, "server stopping");
    await app.stop();
    if (readyFile) removeReadyFile(readyFile);
    logger.info("server stopped");
    await new Promise<void>((resolveFlush, rejectFlush) => {
      logger.flush((error) => (error ? rejectFlush(error) : resolveFlush()));
    });
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
