import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { createApp } from "../src/server.js";

test("SessionEnd removes a thread from the active API and a later prompt reopens it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-lifecycle-"));
  const app = createApp({ databasePath: join(directory, "test.sqlite"), hostname: "127.0.0.1", port: 0 });
  const thread = {
    provider: "claude" as const,
    threadId: "closed-session",
    transcriptPath: join(directory, "session.jsonl"),
    usage: null,
    usageKind: null,
    sourceDevice: 0,
    sourceInode: 0,
    sourceSizeBytes: 0,
    sourceMtimeMs: 0,
    sourceOffsetBytes: 0,
    parserVersion: 3,
    checkedAtMs: Date.now(),
  };

  try {
    app.store.upsert(thread);
    expect(await (await fetch(`${app.url}v1/threads`)).json()).toHaveLength(1);

    const ended = await fetch(`${app.url}v1/hooks/claude`, {
      method: "POST",
      body: JSON.stringify({
        session_id: thread.threadId,
        hook_event_name: "SessionEnd",
        reason: "exit",
      }),
    });
    expect(ended.status).toBe(204);
    expect(app.store.find("claude", thread.threadId)?.state).toBe("closed");
    expect(await (await fetch(`${app.url}v1/threads`)).json()).toEqual([]);

    app.store.upsert(thread);
    expect(app.store.find("claude", thread.threadId)?.state).toBe("active");
    expect(await (await fetch(`${app.url}v1/threads`)).json()).toHaveLength(1);
  } finally {
    await app.stop();
  }
});

test("Stop refreshes stale metrics without blocking the turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-stop-"));
  const app = createApp({
    now: () => Date.parse("2026-08-10T18:00:00.000Z"),
    databasePath: join(directory, "test.sqlite"),
    hostname: "127.0.0.1",
    port: 0,
  });

  try {
    const response = await fetch(`${app.url}v1/hooks/codex`, {
      method: "POST",
      body: JSON.stringify({
        session_id: "stale-stop",
        hook_event_name: "Stop",
        transcript_path: resolve(import.meta.dir, "fixtures/codex-stale.jsonl"),
        model: "gpt-5.6-sol",
      }),
    });

    expect(response.status).toBe(204);
    expect(app.store.find("codex", "stale-stop")?.inputTokensTotal).toBe(150_000);
  } finally {
    await app.stop();
  }
});
