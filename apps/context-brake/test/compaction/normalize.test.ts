import { expect, test } from "bun:test";
import { normalizeClaude } from "../../src/compaction/normalize/claude.js";
import { normalizeCodex } from "../../src/compaction/normalize/codex.js";

test("Codex normalization preserves tool results on their calls", () => {
  const raw = [
    { type: "response_item", payload: { type: "function_call", call_id: "a", name: "A", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call", call_id: "b", name: "B", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "b", output: "result B" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "between" }] } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "a", output: "result A" } },
  ].map((record) => JSON.stringify(record)).join("\n");

  expect(normalizeCodex(raw)).toEqual([
    { kind: "tool", name: "A", input: "{}", output: "result A" },
    { kind: "tool", name: "B", input: "{}", output: "result B" },
    { kind: "message", role: "assistant", text: "between" },
  ]);
});

test("Claude normalization preserves tool results on their calls", () => {
  const raw = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "A", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "result A" }] } },
  ].map((record) => JSON.stringify(record)).join("\n");

  expect(normalizeClaude(raw)).toEqual([
    { kind: "tool", name: "A", input: "{}", output: "result A" },
  ]);
});

test("Claude normalization preserves empty and failed tool results", () => {
  const raw = [
    { type: "assistant", message: { content: [
      { type: "tool_use", id: "ok", name: "A", input: {} },
      { type: "tool_use", id: "bad", name: "B", input: {} },
    ] } },
    { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "ok", content: "" },
      { type: "tool_result", tool_use_id: "bad", content: "error", is_error: true },
    ] } },
  ].map((record) => JSON.stringify(record)).join("\n");

  expect(normalizeClaude(raw)).toEqual([
    { kind: "tool", name: "A", input: "{}", output: "" },
    { kind: "tool", name: "B", input: "{}", output: "error", failed: true },
  ]);
});

test("Claude normalization uses upstream image and document markers", () => {
  const raw = JSON.stringify({
    type: "user",
    message: { content: [
      { type: "image", source: { type: "base64", data: "opaque" } },
      { type: "document", source: { type: "base64", data: "opaque" } },
      { type: "tool_result", tool_use_id: "missing", content: [
        { type: "image", source: { type: "base64", data: "opaque" } },
        { type: "text", text: "visible result" },
      ] },
    ] },
  });

  expect(normalizeClaude(raw)).toEqual([
    { kind: "message", role: "user", text: "[image]" },
    { kind: "message", role: "user", text: "[document]" },
  ]);
});

test("Codex normalization preserves response-item reasoning summaries", () => {
  const raw = [
    { type: "response_item", payload: {
      type: "reasoning",
      id: "r1",
      summary: [{ type: "summary_text", text: "Reasoning summary" }],
      encrypted_content: "opaque ciphertext",
    } },
    { type: "event_msg", payload: { type: "agent_reasoning", text: "Live reasoning" } },
  ].map((record) => JSON.stringify(record)).join("\n");

  expect(normalizeCodex(raw)).toEqual([
    { kind: "reasoning", text: "Reasoning summary" },
    { kind: "reasoning", text: "Live reasoning" },
  ]);
});

test("Codex normalization does not expose encrypted-only reasoning", () => {
  const raw = JSON.stringify({
    type: "response_item",
    payload: { type: "reasoning", encrypted_content: "opaque ciphertext" },
  });

  expect(normalizeCodex(raw)).toEqual([]);
});
