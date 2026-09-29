import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { relayPrompt } from "../src/compaction/prepare.js";
import { createApp } from "../src/server.js";

test("relay streams preparation stages and resolves a closed session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-relay-"));
  const transcriptPath = join(directory, "thread.jsonl");
  await writeFile(transcriptPath, `${JSON.stringify({
    type: "user",
    message: { role: "user", content: "fix the bug" },
  })}\n`);
  const compactionServer = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        summary: "handoff",
        usage: { invocations: 1, inputTokens: 10, outputTokens: 5, chunks: [] },
      });
    },
  });
  const app = createApp({
    databasePath: join(directory, "context-brake.sqlite"),
    port: 0,
    compactionServerUrl: compactionServer.url.toString(),
  });
  app.store.upsert({
    provider: "claude",
    threadId: "00000000-0000-4000-8000-000000000001",
    transcriptPath,
    cwd: directory,
    usage: null,
    usageKind: null,
    sourceDevice: 0,
    sourceInode: 0,
    sourceSizeBytes: 0,
    sourceMtimeMs: 0,
    sourceOffsetBytes: 0,
    parserVersion: 3,
    checkedAtMs: Date.now(),
  });
  app.store.closeThread("claude", "00000000-0000-4000-8000-000000000001", Date.now());

  try {
    const response = await fetch(
      `${app.url}v1/relay/00000000-0000-4000-8000-000000000001`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect((await response.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { stage: "normalizing" },
      { stage: "reducing" },
      { stage: "compacting" },
      {
        stage: "ready",
        provider: "claude",
        cwd: directory,
        model: null,
        effort: null,
        summary: "handoff",
      },
    ]);
  } finally {
    await app.stop();
    await compactionServer.stop(true);
  }
});

test("CLI launches Claude with the prepared relay prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-cli-"));
  const capture = join(directory, "prompt.txt");
  const fakeClaude = join(directory, "claude");
  await writeFile(fakeClaude, "#!/bin/sh\nprintf '%s' \"$1\" > \"$CAPTURE\"\n");
  await chmod(fakeClaude, 0o755);
  const backend = Bun.serve({
    port: 0,
    fetch() {
      return new Response([
        JSON.stringify({ stage: "normalizing" }),
        JSON.stringify({ stage: "reducing" }),
        JSON.stringify({ stage: "compacting" }),
        JSON.stringify({
          stage: "ready",
          provider: "claude",
          cwd: directory,
          model: null,
          effort: null,
          summary: "handoff",
        }),
        "",
      ].join("\n"), { headers: { "content-type": "application/x-ndjson" } });
    },
  });

  try {
    const child = Bun.spawn([
      "/usr/bin/env",
      "bun",
      resolve(import.meta.dir, "../src/cli.ts"),
      "relay",
      "00000000-0000-4000-8000-000000000001",
    ], {
      env: {
        PATH: `${directory}:${Bun.env.PATH ?? ""}`,
        HOME: Bun.env.HOME ?? directory,
        CAPTURE: capture,
        CONTEXT_BRAKE_API_URL: backend.url.toString(),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(await readFile(capture, "utf8")).toBe(relayPrompt("handoff"));
  } finally {
    await backend.stop(true);
  }
});
