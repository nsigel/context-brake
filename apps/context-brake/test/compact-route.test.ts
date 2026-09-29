import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createApp } from "../src/server.js";

test("compact route prepares a stored transcript and forwards it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-compact-"));
  const received: unknown[] = [];
  const compactionServer = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/healthz") {
        return Response.json({ ok: true, model: "test" });
      }
      received.push(await request.json());
      return Response.json({
        summary: "handoff",
        costUsd: 0.01,
        usage: { invocations: 1, inputTokens: 10, outputTokens: 5, chunks: [] },
      });
    },
  });
  const transcriptPath = join(directory, "thread.jsonl");
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    })}\n`,
  );
  const app = createApp({
    databasePath: join(directory, "context-brake.sqlite"),
    port: 0,
    compactionServerUrl: compactionServer.url.toString(),
  });
  app.store.upsert({
    provider: "codex",
    threadId: "thread-1",
    transcriptPath,
    model: "gpt-5.6-sol",
    effort: "high",
    usage: {
      usageEventAtMs: Date.now(),
      model: "gpt-5.6-sol",
      speed: "standard",
      inputTokensTotal: 100_000,
      inputTokensCached: 0,
      inputTokensCacheWrite: 0,
      outputTokens: 1_000,
      contextWindowTokens: 258_400,
    },
    usageKind: "invocation",
    sourceDevice: 0,
    sourceInode: 0,
    sourceSizeBytes: 0,
    sourceMtimeMs: 0,
    sourceOffsetBytes: 0,
    parserVersion: 3,
    checkedAtMs: Date.now(),
  });

  try {
    const health = await fetch(`${app.url}v1/compaction/healthz`);
    expect(health.status).toBe(200);

    const response = await fetch(
      `${app.url}v1/compact?provider=codex&thread_id=thread-1`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      summary: "handoff",
      estimatedSavingsUsd: 0.58125,
      compactionCostUsd: 0.01,
      netSavingsUsd: 0.57125,
    });
    expect(received).toEqual([
      {
        version: 1,
        chunks: [{ events: [{ kind: "message", role: "user", text: "hello" }] }],
      },
    ]);
  } finally {
    await app.stop();
    await compactionServer.stop(true);
  }
});
