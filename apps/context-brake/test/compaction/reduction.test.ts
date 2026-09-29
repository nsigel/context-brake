import { describe, expect, test } from "bun:test";
import type { NormalizedEvent, NormalizedToolEvent } from "../../src/compaction/normalize/types.js";
import { collapseSupersededReads } from "../../src/compaction/reduction/collapse-duplicate-reads.js";
import { stripToolInput } from "../../src/compaction/reduction/strip-tool-input.js";
import { reduceTranscript } from "../../src/compaction/reduction/reduce.js";
function readTool(path: string, output = "content"): NormalizedEvent {
  return { kind: "tool", name: "Read", input: JSON.stringify({ file_path: path }), output };
}

function bashTool(cmd: string, output = ""): NormalizedEvent {
  return { kind: "tool", name: "Bash", input: cmd, output };
}

function msg(role: "user" | "assistant", text: string): NormalizedEvent {
  return { kind: "message", role, text };
}

describe("collapseSupersededReads", () => {
  test("3 reads of same path: keeps all, middle output replaced with marker", () => {
    const events: NormalizedEvent[] = [
      readTool("src/app.ts", "v1"),
      msg("assistant", "editing..."),
      readTool("src/app.ts", "v2"),
      msg("assistant", "editing again..."),
      readTool("src/app.ts", "v3"),
    ];
    const result = collapseSupersededReads(events);
    expect(result).toHaveLength(5);
    const reads = result.filter(
      (e): e is NormalizedToolEvent => e.kind === "tool" && e.name === "Read",
    );
    expect(reads).toHaveLength(3);
    expect(reads[0]!.output).toBe("v1");
    expect(reads[1]!.output).toBe("[intermediate read; see latest read of this file]");
    expect(reads[2]!.output).toBe("v3");
  });

  test("2 reads of same path: both survive", () => {
    const events: NormalizedEvent[] = [
      readTool("src/app.ts", "v1"),
      readTool("src/app.ts", "v2"),
    ];
    expect(collapseSupersededReads(events)).toHaveLength(2);
  });

  test("single read: survives", () => {
    expect(collapseSupersededReads([readTool("src/app.ts")])).toHaveLength(1);
  });

  test("different paths: all survive", () => {
    const events: NormalizedEvent[] = [
      readTool("src/a.ts", "a"),
      readTool("src/b.ts", "b"),
      readTool("src/a.ts", "a2"),
      readTool("src/b.ts", "b2"),
    ];
    expect(collapseSupersededReads(events)).toHaveLength(4);
  });

  test("4 reads of same path: first and last keep output, middle 2 get marker", () => {
    const events: NormalizedEvent[] = [
      readTool("src/app.ts", "v1"),
      readTool("src/app.ts", "v2"),
      readTool("src/app.ts", "v3"),
      readTool("src/app.ts", "v4"),
    ];
    const reads = collapseSupersededReads(events).filter(
      (e): e is NormalizedToolEvent => e.kind === "tool",
    );
    expect(reads).toHaveLength(4);
    expect(reads[0]!.output).toBe("v1");
    expect(reads[1]!.output).toBe("[intermediate read; see latest read of this file]");
    expect(reads[2]!.output).toBe("[intermediate read; see latest read of this file]");
    expect(reads[3]!.output).toBe("v4");
  });

  test("non-read tools are never removed", () => {
    const events: NormalizedEvent[] = [
      bashTool("npm test", "pass"),
      readTool("src/app.ts", "v1"),
      bashTool("npm test", "pass"),
      readTool("src/app.ts", "v2"),
      bashTool("npm test", "fail"),
    ];
    const bashes = collapseSupersededReads(events).filter(
      (e): e is NormalizedToolEvent => e.kind === "tool" && e.name === "Bash",
    );
    expect(bashes).toHaveLength(3);
  });

  test("URL scheme paths are exempt", () => {
    const events: NormalizedEvent[] = [
      readTool("https://example.com/api", "v1"),
      readTool("https://example.com/api", "v2"),
      readTool("https://example.com/api", "v3"),
    ];
    expect(collapseSupersededReads(events)).toHaveLength(3);
  });

  test("unparseable multiline input is exempt", () => {
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "Read", input: "not json\nmultiline", output: "a" },
      { kind: "tool", name: "Read", input: "not json\nmultiline", output: "b" },
    ];
    expect(collapseSupersededReads(events)).toHaveLength(2);
  });

  test("mixed providers: read, Read, file_read all recognized", () => {
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "read", input: JSON.stringify({ path: "src/app.ts" }), output: "v1" },
      msg("assistant", "editing"),
      { kind: "tool", name: "Read", input: JSON.stringify({ file_path: "src/app.ts" }), output: "v2" },
      msg("assistant", "editing"),
      { kind: "tool", name: "file_read", input: JSON.stringify({ path: "src/app.ts" }), output: "v3" },
    ];
    const reads = collapseSupersededReads(events).filter(
      (e): e is NormalizedToolEvent => e.kind === "tool",
    );
    expect(reads).toHaveLength(3);
    expect(reads[0]!.output).toBe("v1");
    expect(reads[1]!.output).toBe("[intermediate read; see latest read of this file]");
    expect(reads[2]!.output).toBe("v3");
  });

  test("different selectors tracked independently", () => {
    const events: NormalizedEvent[] = [
      readTool("src/foo.ts:50-200", "a"),
      readTool("src/foo.ts:100-300", "b"),
    ];
    expect(collapseSupersededReads(events)).toHaveLength(2);
  });

  test("plain path string input recognized", () => {
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "read", input: "src/app.ts", output: "v1" },
      msg("assistant", "editing"),
      { kind: "tool", name: "read", input: "src/app.ts", output: "v2" },
      msg("assistant", "editing"),
      { kind: "tool", name: "read", input: "src/app.ts", output: "v3" },
    ];
    const reads = collapseSupersededReads(events).filter(
      (e): e is NormalizedToolEvent => e.kind === "tool",
    );
    expect(reads).toHaveLength(3);
    expect(reads[0]!.output).toBe("v1");
    expect(reads[1]!.output).toBe("[intermediate read; see latest read of this file]");
    expect(reads[2]!.output).toBe("v3");
  });

  test("empty array returns empty", () => {
    expect(collapseSupersededReads([])).toEqual([]);
  });
});

describe("stripToolInput", () => {
  test("read tool input stripped to path", () => {
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "Read", input: '{"file_path":"src/foo.ts"}', output: "content" },
    ];
    const result = stripToolInput(events);
    expect(result[0]!).toHaveProperty("input", "src/foo.ts");
    expect(result[0]!).toHaveProperty("output", "content");
  });

  test("read tool with selector", () => {
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "read", input: '{"path":"src/foo.ts","selector":"50-200"}', output: "lines" },
    ];
    const result = stripToolInput(events);
    expect(result[0]!).toHaveProperty("input", "src/foo.ts:50-200");
  });

  test("read tool with bare string input unchanged", () => {
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "read", input: "src/foo.ts", output: "content" },
    ];
    const result = stripToolInput(events);
    expect(result[0]!).toHaveProperty("input", "src/foo.ts");
  });

  test("bash input truncated at newline", () => {
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "Bash", input: "cat <<EOF\nlong content\nEOF", output: "done" },
    ];
    const result = stripToolInput(events);
    expect(result[0]!).toHaveProperty("input", "cat <<EOF");
  });

  test("bash input truncated at 200 chars", () => {
    const longCmd = "x".repeat(300);
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "bash", input: longCmd, output: "done" },
    ];
    const result = stripToolInput(events);
    const stripped = (result[0] as NormalizedToolEvent).input;
    expect(stripped.length).toBe(201); // 200 chars + "…"
    expect(stripped).toEndWith("…");
  });

  test("short bash input unchanged", () => {
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "Bash", input: "npm test", output: "pass" },
    ];
    const result = stripToolInput(events);
    expect(result[0]!).toHaveProperty("input", "npm test");
  });

  test("edit tool input preserved", () => {
    const input = '{"file_path":"src/foo.ts","new_string":"...big content..."}';
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "Edit", input, output: "ok" },
    ];
    const result = stripToolInput(events);
    expect(result[0]!).toHaveProperty("input", input);
  });

  test("write tool input preserved", () => {
    const input = '{"path":"src/foo.ts","content":"' + "x".repeat(5000) + '"}';
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "Write", input, output: "ok" },
    ];
    const result = stripToolInput(events);
    expect(result[0]!).toHaveProperty("input", input);
  });

  test("unknown tool unchanged", () => {
    const events: NormalizedEvent[] = [
      { kind: "tool", name: "custom_mcp", input: "whatever", output: "result" },
    ];
    const result = stripToolInput(events);
    expect(result[0]!).toHaveProperty("input", "whatever");
  });

  test("non-tool events unchanged", () => {
    const events: NormalizedEvent[] = [
      msg("user", "hello"),
      { kind: "reasoning", text: "thinking..." },
    ];
    const result = stripToolInput(events);
    expect(result).toEqual(events);
  });
});

describe("reduceTranscript flag integration", () => {
  test("lossy reductions default off", () => {
    const events: NormalizedEvent[] = [
      msg("user", "read this file"),
      { kind: "tool", name: "Read", input: '{"file_path":"src/foo.ts"}', output: "x".repeat(3_000) },
    ];
    const result = reduceTranscript(events);
    const tool = result.find((e): e is NormalizedToolEvent => e.kind === "tool")!;
    expect(tool.input).toBe('{"file_path":"src/foo.ts"}');
    expect(tool.output).toHaveLength(3_000);
  });

  test("stripToolInput explicitly on strips input", () => {
    const events: NormalizedEvent[] = [
      msg("user", "read this file"),
      { kind: "tool", name: "Read", input: '{"file_path":"src/foo.ts"}', output: "content" },
    ];
    const result = reduceTranscript(events, { stripToolInput: true });
    const tool = result.find((e): e is NormalizedToolEvent => e.kind === "tool")!;
    expect(tool.input).toBe("src/foo.ts");
  });

  test("collapseSupersededReads flag works", () => {
    const events: NormalizedEvent[] = [
      readTool("src/app.ts", "v1"),
      readTool("src/app.ts", "v2"),
      readTool("src/app.ts", "v3"),
    ];
    // By default, all 3 reads keep original output.
    const withDefault = reduceTranscript(events);
    const reads = withDefault.filter((e): e is NormalizedToolEvent => e.kind === "tool");
    expect(reads).toHaveLength(3);
    expect(reads[1]!.output).toContain("v2");

    // Explicitly enabling the reduction replaces the middle output.
    const withFlag = reduceTranscript(events, { collapseSupersededReads: true });
    const reducedReads = withFlag.filter((e): e is NormalizedToolEvent => e.kind === "tool");
    expect(reducedReads).toHaveLength(3);
    expect(reducedReads[1]!.output).toBe("[intermediate read; see latest read of this file]");
  });

  test("pipeline ordering: supersede runs before input stripping", () => {
    const events: NormalizedEvent[] = [
      readTool("src/app.ts", "v1"),
      msg("assistant", "editing"),
      readTool("src/app.ts", "v2"),
      msg("assistant", "more editing"),
      readTool("src/app.ts", "v3"),
    ];
    const result = reduceTranscript(events, {
      collapseSupersededReads: true,
      stripToolInput: true,
    });
    const reads = result.filter((e): e is NormalizedToolEvent => e.kind === "tool");
    // All 3 reads survive; middle one has marker output
    expect(reads).toHaveLength(3);
    expect(reads[0]!.output).toContain("v1");
    expect(reads[1]!.output).toBe("[intermediate read; see latest read of this file]");
    expect(reads[2]!.output).toContain("v3");
    // Input stripping also ran — inputs are bare paths not JSON
    expect(reads[0]!.input).toBe("src/app.ts");
    expect(reads[2]!.input).toBe("src/app.ts");
  });
});
