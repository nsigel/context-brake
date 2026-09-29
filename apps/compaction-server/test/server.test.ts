import { expect, test } from "bun:test";
import { createApp } from "../src/server.js";

test("HTTP server exposes health and compaction endpoints", async () => {
  const app = createApp({
    port: 0,
      modelId: "deepseek.v3.2",
      awsRegion: "us-east-1",
      maximumOutputTokens: 8_000,
      inputUsdPerMillion: 0.62,
      outputUsdPerMillion: 1.85,
    runCompaction: async () => ({
      summary: "handoff",
      usage: {
        invocations: 1,
        inputTokens: 100,
        outputTokens: 10,
        reasoningCharacters: 42,
        chunks: [{ index: 0, inputTokens: 100, outputTokens: 10, reasoningCharacters: 42 }],
      },
    }),
  });

  try {
    const health = await fetch(new URL("/healthz", app.url));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      model: "deepseek.v3.2",
      region: "us-east-1",
      maximumOutputTokens: 8_000,
      systemPromptSha256: expect.any(String),
    });

    const response = await fetch(new URL("/v1/compactions", app.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        chunks: [
          { events: [{ kind: "message", role: "user", text: "continue" }] },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary: "handoff",
      costUsd: 0.0000805,
      usage: {
        invocations: 1,
        inputTokens: 100,
        outputTokens: 10,
        reasoningCharacters: 42,
        chunks: [{ index: 0, inputTokens: 100, outputTokens: 10, reasoningCharacters: 42 }],
      },
    });
  } finally {
    await app.stop();
  }
});

test("HTTP server reports malformed contracts without invoking the model", async () => {
  let invoked = false;
  const app = createApp({
    port: 0,
    runCompaction: async () => {
      invoked = true;
      throw new Error("not expected");
    },
  });

  try {
    const response = await fetch(new URL("/v1/compactions", app.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 9, chunks: [] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "unsupported_request_version",
    });
    expect(invoked).toBe(false);
  } finally {
    await app.stop();
  }
});

test("keeps a slow compaction request alive", async () => {
  const app = createApp({
    port: 0,
    runCompaction: async () => {
      await Bun.sleep(10_500);
      return {
        summary: "handoff",
        usage: {
          invocations: 1,
          inputTokens: 1,
          outputTokens: 1,
          reasoningCharacters: 0,
          chunks: [{ index: 0, inputTokens: 1, outputTokens: 1, reasoningCharacters: 0 }],
        },
      };
    },
  });

  try {
    const response = await fetch(new URL("/v1/compactions", app.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        chunks: [{ events: [{ kind: "message", role: "user", text: "continue" }] }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary?: string };
    expect(body.summary).toBe("handoff");
  } finally {
    await app.stop();
  }
}, 20_000);
