#!/usr/bin/env bun

import { writeSync } from "node:fs";
import { relayPrompt } from "./compaction/prepare.js";

interface ReadyEvent {
  stage: "ready";
  provider: "claude" | "codex";
  cwd: string | null;
  model: string | null;
  effort: string | null;
  summary: string;
}

async function main(): Promise<number> {
  const [command, threadId, extra] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    process.stdout.write("Usage: context-brake relay <session-id>\n");
    return 0;
  }
  if (command !== "relay" || !threadId || extra !== undefined) {
    process.stderr.write("Usage: context-brake relay <session-id>\n");
    return 2;
  }

  const status = statusLine();
  try {
    status.update("Connecting…");
    const baseUrl = await backendUrl();
    const response = await fetch(new URL(`v1/relay/${encodeURIComponent(threadId)}`, baseUrl), {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(await responseError(response));
    if (!response.body) throw new Error("Context Brake returned an empty relay response");

    let ready: ReadyEvent | undefined;
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        if (typeof event.error === "string") throw new Error(event.error.replaceAll("_", " "));
        if (event.stage === "normalizing") status.update("Normalizing transcript…");
        if (event.stage === "reducing") status.update("Reducing transcript…");
        if (event.stage === "compacting") status.update("Compacting transcript…");
        if (isReadyEvent(event)) ready = event;
      }
    }
    if (!ready) throw new Error("Context Brake did not return a handoff summary");

    const agent = ready.provider === "claude" ? "claude" : "codex";
    const agentOptions = ready.provider === "claude"
      ? [
          ...(ready.model ? ["--model", ready.model] : []),
          ...(ready.effort ? ["--effort", ready.effort] : []),
        ]
      : [
          ...(ready.model ? ["--model", ready.model] : []),
          ...(ready.effort ? ["--config", `model_reasoning_effort=${JSON.stringify(ready.effort)}`] : []),
        ];
    status.finish(`Launching ${ready.provider === "claude" ? "Claude" : "Codex"}…`);
    const child = Bun.spawn([agent, ...agentOptions, relayPrompt(ready.summary)], {
      cwd: ready.cwd ?? process.cwd(),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  } catch (error) {
    status.clear();
    process.stderr.write(`context-brake: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function backendUrl(): Promise<URL> {
  return withTrailingSlash(
    Bun.env.CONTEXT_BRAKE_API_URL ?? "http://127.0.0.1:7788/",
  );
}

function withTrailingSlash(value: string): URL {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") return body.error.replaceAll("_", " ");
  } catch {
    // Fall through to the HTTP status.
  }
  return `backend returned HTTP ${response.status}`;
}

function isReadyEvent(event: Record<string, unknown>): event is Record<string, unknown> & ReadyEvent {
  return event.stage === "ready" &&
    (event.provider === "claude" || event.provider === "codex") &&
    (event.cwd === null || typeof event.cwd === "string") &&
    (event.model === null || typeof event.model === "string") &&
    (event.effort === null || typeof event.effort === "string") &&
    typeof event.summary === "string";
}

function statusLine(): {
  update: (message: string) => void;
  finish: (message: string) => void;
  clear: () => void;
} {
  const interactive = Boolean(process.stderr.isTTY);
  let visible = false;
  const write = (message: string, newline: boolean): void => {
    if (interactive) {
      writeSync(2, `\r\x1b[2KContext Brake · ${message}${newline ? "\n" : ""}`);
    } else {
      writeSync(2, `Context Brake · ${message}\n`);
    }
    visible = !newline;
  };
  return {
    update: (message) => write(message, false),
    finish: (message) => write(message, true),
    clear: () => {
      if (interactive && visible) writeSync(2, "\r\x1b[2K");
      visible = false;
    },
  };
}

process.exitCode = await main();
