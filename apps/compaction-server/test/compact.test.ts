import { expect, test } from "bun:test";
import { compact, type CompleteCompaction } from "../src/compact.js";
import { loadConfig } from "../src/config.js";
import type { CompactionRequest } from "../src/contract.js";
import { compactionInput, COMPACTION_SYSTEM_PROMPT } from "../src/prompt.js";

test("uses the Claude-compatible checkpoint handoff prompt", () => {
  expect(COMPACTION_SYSTEM_PROMPT)
    .toBe(`Create a detailed handoff summary for a Claude Code agent that will continue the task from the rendered conversation transcript.

Summarize the transcript instead of continuing the task. Fold new events into the existing checkpoint without duplicating information.

Preserve the user's current request and intent, important technical context, files and code involved, actions taken, decisions, commands and test results, errors and fixes, user feedback and constraints, current work, pending tasks, and the concrete next step. Preserve exact names, values, and code when they matter for continuation. Do not invent details absent from the supplied data. The continuing agent has the same tools; [image] and [document] mean omitted media, so advise rereading with Read, not OCR. Before responding, double-check factual accuracy and internal consistency.`);
  expect(loadConfig({})).toMatchObject({
    modelId: "deepseek.v3.2",
    inputUsdPerMillion: 0.62,
    outputUsdPerMillion: 1.85,
  });
});

test("renders normalized events as a readable conversation", () => {
  expect(compactionInput("Earlier work", { events: [
    { kind: "message", role: "user", text: "Fix it" },
    { kind: "reasoning", text: "Inspect first" },
    { kind: "tool", name: "Read", input: '{"file_path":"/app/a.ts"}', output: "source text" },
  ] })).toBe(`EXISTING CHECKPOINT
Earlier work

NEW CONVERSATION EVENTS

EVENT 1 — USER
Fix it

EVENT 2 — ASSISTANT REASONING
Inspect first

EVENT 3 — ASSISTANT TOOL CALL: Read
{"file_path":"/app/a.ts"}

TOOL RESULT
source text`);
});

test("compact folds each chronological chunk into the running checkpoint", async () => {
  const calls: Array<{ system: string; input: string }> = [];
  const complete: CompleteCompaction = async (system, input) => {
    calls.push({ system, input });
    return {
      text: `summary ${calls.length}`,
      inputTokens: calls.length * 10,
      outputTokens: calls.length * 2,
      reasoningCharacters: calls.length * 3,
    };
  };
  const request: CompactionRequest = {
    version: 1,
    checkpoint: "Claude checkpoint",
    chunks: [
      { events: [{ kind: "message", role: "user", text: "first" }] },
      { events: [{ kind: "message", role: "assistant", text: "second" }] },
    ],
  };

  const result = await compact(request, complete);

  expect(calls).toHaveLength(2);
  expect(calls[0]?.input).toContain("Claude checkpoint");
  expect(calls[1]?.input).toContain("summary 1");
  expect(calls[0]?.system).toBe(COMPACTION_SYSTEM_PROMPT);
  expect(result).toEqual({
    summary: "summary 2",
    usage: {
      invocations: 2,
      inputTokens: 30,
      outputTokens: 6,
      reasoningCharacters: 9,
      chunks: [
        { index: 0, inputTokens: 10, outputTokens: 2, reasoningCharacters: 3 },
        { index: 1, inputTokens: 20, outputTokens: 4, reasoningCharacters: 6 },
      ],
    },
  });
});

test("checkpoint-only requests return the existing checkpoint without invoking Bedrock", async () => {
  const result = await compact(
    { version: 1, checkpoint: "already compacted", chunks: [] },
    async () => {
      throw new Error("should not run");
    },
  );
  expect(result).toEqual({
    summary: "already compacted",
    usage: {
      invocations: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningCharacters: 0,
      chunks: [],
    },
  });
});
