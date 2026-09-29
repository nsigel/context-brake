import { appendFile, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ThreadStore } from "../src/db.js";
import { JitEvaluator } from "../src/evaluator.js";
import { findModelPolicy, loadPolicy } from "../src/policy.js";

const NOW = Date.parse("2026-08-10T18:00:00.000Z");

test("Claude Opus 5 uses its one-hour cache pricing policy", () => {
  const model = findModelPolicy(loadPolicy(), "claude", "claude-opus-5");
  expect(model && {
    input: model.inputUsdPerMillion,
    cached: model.cachedInputUsdPerMillion,
    cacheWrite: model.cacheWriteUsdPerMillion,
    output: model.outputUsdPerMillion,
    contextWindow: model.contextWindowTokens,
    fast: model.fast && {
      input: model.fast.inputUsdPerMillion,
      cached: model.fast.cachedInputUsdPerMillion,
      cacheWrite: model.fast.cacheWriteUsdPerMillion,
      output: model.fast.outputUsdPerMillion,
    },
  }).toEqual({
    input: 5,
    cached: 0.5,
    cacheWrite: 10,
    output: 25,
    contextWindow: 1_000_000,
    fast: {
      input: 10,
      cached: 1,
      cacheWrite: 20,
      output: 50,
    },
  });
});

test("Claude policies cover non-Sonnet 5 models", () => {
  const policy = loadPolicy();
  for (const [model, contextWindow] of [
    ["claude-fable-5", 1_000_000],
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-opus-4-5", 200_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-sonnet-4-5", 200_000],
    ["claude-haiku-4-5", 200_000],
    ["claude-3-5-haiku-20241022", 200_000],
  ] as const) {
    expect(findModelPolicy(policy, "claude", model)?.contextWindowTokens).toBe(contextWindow);
  }
});

test("Claude fast mode uses fast cache pricing and persists speed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-fast-"));
  const transcript = join(directory, "session.jsonl");
  await writeFile(transcript, `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-10T16:00:00.000Z",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 100000, output_tokens: 1000, speed: "fast" },
    },
  })}\n`);

  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    const result = await evaluator.evaluate("claude", {
      session_id: "claude-fast-1",
      transcript_path: transcript,
      prompt: "",
    });
    expect(result.action).toBe("block");
    expect(result.reason).toMatch(/Resubmit the prompt to continue/i);
    const later = await evaluator.evaluate("claude", {
      session_id: "claude-fast-1",
      transcript_path: transcript,
      prompt: "continue normally",
    });
    expect(later.action).toBe("continue");
    const blockedAgain = await evaluator.evaluate("claude", {
      session_id: "claude-fast-1",
      transcript_path: transcript,
      prompt: "third prompt",
    });
    expect(blockedAgain.action).toBe("block");
    expect(store.find("claude", "claude-fast-1")?.speed).toBe("fast");
    expect({
      model: result.model,
      speed: result.speed,
      cacheAgeMs: result.cacheAgeMs,
      cacheTtlMs: result.cacheTtlMs,
      estimatedContextTokens: result.estimatedContextTokens,
      estimatedHandoffTokens: result.estimatedHandoffTokens,
      estimatedAvoidedTokens: result.estimatedAvoidedTokens,
      cacheWriteUsdPerMillion: result.cacheWriteUsdPerMillion,
      estimatedSavingsUsd: result.estimatedSavingsUsd,
      minimumSavingsUsd: result.minimumSavingsUsd,
    }).toEqual({
      model: "claude-opus-4-8",
      speed: "fast",
      cacheAgeMs: 2 * 60 * 60 * 1000,
      cacheTtlMs: 60 * 60 * 1000,
      estimatedContextTokens: 101_000,
      estimatedHandoffTokens: 8_000,
      estimatedAvoidedTokens: 93_000,
      cacheWriteUsdPerMillion: 20,
      estimatedSavingsUsd: (93_000 / 1_000_000) * 20,
      minimumSavingsUsd: 0.05,
    });
  } finally {
    store.close();
  }
});

test("duplicate prompt hooks do not consume the next-turn retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-retry-turn-"));
  const transcript = join(directory, "session.jsonl");
  await writeFile(transcript, `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-10T16:00:00.000Z",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 100000, output_tokens: 1000 },
    },
  })}\n`);

  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    const input = (turn_id: string) => ({
      session_id: "duplicate-hook-1",
      transcript_path: transcript,
      prompt: "continue",
      hook_event_name: "UserPromptSubmit",
      turn_id,
    });

    expect((await evaluator.evaluate("claude", input("turn-1"))).action).toBe("block");
    expect((await evaluator.evaluate("claude", input("turn-1"))).action).toBe("block");
    expect((await evaluator.evaluate("claude", input("turn-2"))).action).toBe("continue");
    expect((await evaluator.evaluate("claude", input("turn-2"))).action).toBe("continue");
    expect((await evaluator.evaluate("claude", input("turn-3"))).action).toBe("block");
  } finally {
    store.close();
  }
});

test("Codex first JIT check reverse-tails token_count and blocks a stale expensive thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-codex-"));
  const transcript = join(directory, "rollout.jsonl");
  await writeFile(
    transcript,
    [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-10T10:00:00.000Z", payload: {} }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-10T10:00:01.000Z",
        payload: { type: "turn_context", effort: "high" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-10T16:00:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model_context_window: 258400,
            last_token_usage: {
              input_tokens: 108435,
              cached_input_tokens: 106240,
              cache_write_input_tokens: 1000,
              output_tokens: 1532,
            },
          },
        },
      }),
      "",
    ].join("\n"),
  );

  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    const result = await evaluator.evaluate("codex", {
      session_id: "codex-1",
      transcript_path: transcript,
      cwd: directory,
      model: "gpt-5.6-sol",
      prompt: "continue",
    });
    expect(result.action).toBe("block");
    expect(result.reason ?? "").toMatch(/108,000|101,000|saving/i);
    const resent = await evaluator.evaluate("codex", {
      session_id: "codex-1",
      transcript_path: transcript,
      cwd: directory,
      model: "gpt-5.6-sol",
      prompt: "continue again",
    });
    expect(resent.action).toBe("continue");

    const blockedAgain = await evaluator.evaluate("codex", {
      session_id: "codex-1",
      transcript_path: transcript,
      cwd: directory,
      model: "gpt-5.6-sol",
      prompt: "third prompt",
    });
    expect(blockedAgain.action).toBe("block");

    const row = store.find("codex", "codex-1");
    expect(row?.inputTokensTotal).toBe(108435);
    expect(row?.inputTokensCached).toBe(106240);
    expect(row?.inputTokensCacheWrite).toBe(1000);
    expect(result.estimatedContextTokens).toBe(108435 + 1532 + 2);
    expect(row?.effort).toBe("high");
    expect(store.list()).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("Codex keeps the post-compaction context size from a zeroed token snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-codex-compacted-"));
  const transcript = join(directory, "rollout.jsonl");
  await writeFile(
    transcript,
    [
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-08-10T17:59:00.000Z",
        payload: { message: "redacted", replacement_history: [], window_id: 1 },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-10T17:59:00.001Z",
        payload: {
          type: "token_count",
          info: {
            model_context_window: 258400,
            last_token_usage: {
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: 8805,
            },
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-10T17:59:00.002Z",
        payload: { type: "context_compacted" },
      }),
      "",
    ].join("\n"),
  );

  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    const result = await evaluator.evaluate("codex", {
      session_id: "codex-compacted-1",
      transcript_path: transcript,
      model: "gpt-5.6-sol",
      prompt: "continue",
    });

    expect(result.action).toBe("continue");
    expect(result.estimatedContextTokens).toBe(8807);
    expect(store.find("codex", "codex-compacted-1")?.inputTokensTotal).toBe(8805);
  } finally {
    store.close();
  }
});

test("Claude normalizes cache usage and incrementally advances the same row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-claude-"));
  const transcript = join(directory, "session.jsonl");
  const first = JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-10T17:30:00.000Z",
    isSidechain: false,
    message: {
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 1555,
        cache_read_input_tokens: 63342,
        output_tokens: 704,
      },
    },
  });
  await writeFile(transcript, `${first}\n`);

  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    const fresh = await evaluator.evaluate("claude", {
      session_id: "claude-1",
      transcript_path: transcript,
      cwd: directory,
      prompt: "continue",
    });
    expect(fresh.action).toBe("continue");
    expect(store.find("claude", "claude-1")?.inputTokensTotal).toBe(64899);
    expect(store.find("claude", "claude-1")?.inputTokensCached).toBe(63342);
    expect(store.find("claude", "claude-1")?.inputTokensCacheWrite).toBe(1555);
    expect(fresh.estimatedContextTokens).toBe(64899 + 704 + 2);
    expect(store.find("claude", "claude-1")?.contextWindowTokens).toBe(1_000_000);

    await appendFile(transcript, `${JSON.stringify({ type: "user", timestamp: "2026-08-10T17:59:00.000Z" })}\n`);
    await evaluator.evaluate("claude", {
      session_id: "claude-1",
      transcript_path: transcript,
      cwd: directory,
      prompt: "another prompt",
    });

    const row = store.find("claude", "claude-1");
    expect(row?.inputTokensTotal).toBe(64899);
    expect(store.list()).toHaveLength(1);
    expect(row?.sourceOffsetBytes).toBe((await stat(transcript)).size);
  } finally {
    store.close();
  }
});

test("Claude keeps the post-compaction context size from compact metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-claude-compacted-"));
  const transcript = join(directory, "session.jsonl");
  await writeFile(
    transcript,
    [
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-08-10T17:59:00.000Z",
        content: "redacted",
        compactMetadata: {
          trigger: "auto",
          preTokens: 169508,
          postTokens: 3000,
          cumulativeDroppedTokens: 166508,
          durationMs: 104253,
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-10T17:59:00.001Z",
        isCompactSummary: true,
        message: { role: "user", content: "redacted" },
      }),
      "",
    ].join("\n"),
  );

  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    const result = await evaluator.evaluate("claude", {
      session_id: "claude-compacted-1",
      transcript_path: transcript,
      model: "claude-sonnet-5",
      prompt: "continue",
    });

    expect(result.action).toBe("continue");
    expect(result.estimatedContextTokens).toBe(3002);
    expect(store.find("claude", "claude-compacted-1")?.inputTokensTotal).toBe(3000);
  } finally {
    store.close();
  }
});

test("Claude checkpoints update context without replacing invocation identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-claude-checkpoint-"));
  const transcript = join(directory, "session.jsonl");
  await writeFile(transcript, `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-10T17:30:00.000Z",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 100000, output_tokens: 1000, speed: "fast" },
    },
  })}\n`);

  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    await evaluator.evaluate("claude", {
      session_id: "claude-checkpoint-1",
      transcript_path: transcript,
      prompt: "continue",
    });
    await appendFile(transcript, `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      timestamp: "2026-08-10T17:59:00.000Z",
      compactMetadata: { postTokens: 3000 },
    })}\n`);

    await evaluator.evaluate("claude", {
      session_id: "claude-checkpoint-1",
      transcript_path: transcript,
      prompt: "continue",
    });

    const row = store.find("claude", "claude-checkpoint-1");
    expect(row?.inputTokensTotal).toBe(3000);
    expect(row?.outputTokens).toBe(0);
    expect(row?.model).toBe("claude-opus-4-8");
    expect(row?.speed).toBe("fast");
    expect(row?.contextWindowTokens).toBe(1_000_000);
  } finally {
    store.close();
  }
});

test("an incoming model change blocks even while the existing cache is fresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-model-change-"));
  const transcript = join(directory, "session.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-10T17:59:00.000Z",
      message: {
        model: "claude-sonnet-5",
        usage: { input_tokens: 100000, output_tokens: 1000 },
      },
    })}\n`,
  );

  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    const initial = await evaluator.evaluate("claude", {
      session_id: "model-change-1",
      transcript_path: transcript,
      prompt: "continue",
    });
    expect(initial.action).toBe("continue");

    const changed = await evaluator.evaluate("claude", {
      session_id: "model-change-1",
      transcript_path: transcript,
      model: "claude-opus-5",
      prompt: "continue with opus",
    });
    expect(changed.action).toBe("block");
    expect(changed.model).toBe("claude-opus-5");
    expect(changed.reason ?? "").toMatch(/changing.*sonnet.*opus.*rebuild/i);
    expect(store.find("claude", "model-change-1")?.model).toBe("claude-sonnet-5");
  } finally {
    store.close();
  }
});

test("the same incoming model continues through the normal TTL decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-same-model-"));
  const transcript = join(directory, "session.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-10T17:59:00.000Z",
      message: {
        model: "claude-sonnet-5",
        usage: { input_tokens: 100000, output_tokens: 1000 },
      },
    })}\n`,
  );

  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    await evaluator.evaluate("claude", {
      session_id: "same-model-1",
      transcript_path: transcript,
      prompt: "continue",
    });

    const result = await evaluator.evaluate("claude", {
      session_id: "same-model-1",
      transcript_path: transcript,
      model: "claude-sonnet-5",
      prompt: "continue",
    });
    expect(result.action).toBe("continue");
    expect(result.cacheAgeMs).toBe(60_000);
  } finally {
    store.close();
  }
});

test("unknown models fail open rather than inventing a price", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-unknown-"));
  const transcript = join(directory, "session.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-09T10:00:00.000Z",
      message: {
        model: "claude-unknown",
        usage: { input_tokens: 200000, output_tokens: 1000 },
      },
    })}\n`,
  );
  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    const result = await evaluator.evaluate("claude", {
      session_id: "unknown-1",
      transcript_path: transcript,
      prompt: "continue",
    });
    expect(result.action).toBe("continue");
  } finally {
    store.close();
  }
});

test("missing transcript paths fail open for both providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-no-transcript-"));
  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);

    for (const provider of ["codex", "claude"] as const) {
      const result = await evaluator.evaluate(provider, {
        session_id: `${provider}-missing-path`,
        prompt: "continue",
      });
      expect(result.action).toBe("continue");
      expect(store.find(provider, `${provider}-missing-path`)).toBeNull();
    }
  } finally {
    store.close();
  }
});

test("transcript read failures fail open with the original error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-read-error-"));
  const store = new ThreadStore(join(directory, "test.sqlite"));
  try {
    const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
    const result = await evaluator.evaluate("codex", {
      session_id: "codex-read-error",
      transcript_path: directory,
      model: "gpt-5.6-sol",
      prompt: "continue",
    });

    expect(result.action).toBe("continue");
    expect(result.error).toBeInstanceOf(Error);
  } finally {
    store.close();
  }
});
