// Scored evaluation: labeled thread scenarios in, block/continue out, accuracy
// asserted. Runs the real path (transcript -> parser -> policy -> decision), so
// a pricing or TTL change that flips a judgement shows up here as a score drop.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ThreadStore } from "../src/db.js";
import { JitEvaluator } from "../src/evaluator.js";
import { loadPolicy } from "../src/policy.js";
import type { Provider } from "../src/types.js";

const NOW = Date.parse("2026-08-10T18:00:00.000Z");

interface Case {
  name: string;
  provider: Provider;
  model: string;
  ageMinutes: number;
  inputTokens: number;
  outputTokens: number;
  prompt?: string;
  expected: "block" | "continue";
}

const CASES: Case[] = [
  // Fresh threads are never worth braking, however large.
  { name: "fresh huge opus thread", provider: "claude", model: "claude-opus-5", ageMinutes: 10, inputTokens: 200_000, outputTokens: 4_000, expected: "continue" },
  { name: "cache TTL boundary", provider: "claude", model: "claude-opus-5", ageMinutes: 60, inputTokens: 200_000, outputTokens: 4_000, expected: "continue" },
  { name: "one minute past TTL", provider: "claude", model: "claude-opus-5", ageMinutes: 61, inputTokens: 200_000, outputTokens: 4_000, expected: "block" },

  // Stale, but too small for a handoff to pay for itself.
  { name: "stale thread below handoff size", provider: "claude", model: "claude-opus-5", ageMinutes: 180, inputTokens: 5_000, outputTokens: 500, expected: "continue" },
  { name: "stale thread below minimum savings", provider: "claude", model: "claude-opus-5", ageMinutes: 180, inputTokens: 10_000, outputTokens: 500, expected: "continue" },
  { name: "stale thread just above minimum savings", provider: "claude", model: "claude-opus-5", ageMinutes: 180, inputTokens: 20_000, outputTokens: 1_000, expected: "block" },

  // Cheap models need a much bigger thread before a brake is worth it.
  { name: "stale mid-size haiku thread", provider: "claude", model: "claude-haiku-4-5", ageMinutes: 180, inputTokens: 30_000, outputTokens: 500, expected: "continue" },
  { name: "stale huge haiku thread", provider: "claude", model: "claude-haiku-4-5", ageMinutes: 180, inputTokens: 180_000, outputTokens: 2_000, expected: "block" },
  { name: "stale sonnet thread", provider: "claude", model: "claude-sonnet-5", ageMinutes: 300, inputTokens: 120_000, outputTokens: 3_000, expected: "block" },

  // Unknown pricing must fail open.
  { name: "unknown model", provider: "claude", model: "claude-nonexistent-9", ageMinutes: 600, inputTokens: 400_000, outputTokens: 9_000, expected: "continue" },

  { name: "stale codex thread", provider: "codex", model: "gpt-5.6-sol", ageMinutes: 240, inputTokens: 150_000, outputTokens: 2_000, expected: "block" },
  { name: "fresh codex thread", provider: "codex", model: "gpt-5.6-sol", ageMinutes: 5, inputTokens: 150_000, outputTokens: 2_000, expected: "continue" },
];

function transcriptLine(testCase: Case): string {
  const timestamp = new Date(NOW - testCase.ageMinutes * 60_000).toISOString();
  if (testCase.provider === "claude") {
    return JSON.stringify({
      type: "assistant",
      timestamp,
      message: {
        model: testCase.model,
        usage: { input_tokens: testCase.inputTokens, output_tokens: testCase.outputTokens },
      },
    });
  }
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: testCase.inputTokens,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: testCase.outputTokens,
        },
      },
    },
  });
}

test("evaluation suite: brake decisions match labelled expectations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-eval-"));
  const store = new ThreadStore(join(directory, "eval.sqlite"));
  const evaluator = new JitEvaluator(store, loadPolicy(), () => NOW);
  const rows: string[] = [];
  const failures: string[] = [];
  let correct = 0;

  try {
    for (const [index, testCase] of CASES.entries()) {
      const transcript = join(directory, `case-${index}.jsonl`);
      await writeFile(transcript, `${transcriptLine(testCase)}\n`);
      const result = await evaluator.evaluate(testCase.provider, {
        session_id: `eval-${index}`,
        transcript_path: transcript,
        model: testCase.model,
        prompt: testCase.prompt ?? "continue",
      });

      const ok = result.action === testCase.expected;
      if (ok) correct += 1;
      else failures.push(`${testCase.name}: expected ${testCase.expected}, got ${result.action}`);
      rows.push(
        `${ok ? "PASS" : "FAIL"}  ${testCase.name.padEnd(38)} ${result.action.padEnd(8)} ` +
          `$${(result.estimatedSavingsUsd ?? 0).toFixed(3)}`,
      );
    }
  } finally {
    store.close();
  }

  console.log(
    [`\nevaluation: ${correct}/${CASES.length} correct`, ...rows, ""].join("\n"),
  );
  expect(failures).toEqual([]);
});
