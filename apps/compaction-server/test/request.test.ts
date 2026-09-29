import { expect, test } from "bun:test";
import { parseCompactionRequest, RequestError } from "../src/request.js";

test("request parser accepts only compactable wire events", () => {
  expect(parseCompactionRequest({
    version: 1,
    chunks: [{
      events: [
        { kind: "message", role: "user", text: "hello" },
        { kind: "tool", name: "Bash", input: "bun test", output: "passed", failed: false },
      ],
    }],
  })).toEqual({
    version: 1,
    chunks: [{
      events: [
        { kind: "message", role: "user", text: "hello" },
        { kind: "tool", name: "Bash", input: "bun test", output: "passed", failed: false },
      ],
    }],
  });
});

test("request parser accepts reasoning events", () => {
  const result = parseCompactionRequest({
    version: 1,
    chunks: [{ events: [{ kind: "reasoning", text: "thinking about approach" }] }],
  });
  expect(result.chunks[0]!.events[0]).toEqual({
    kind: "reasoning",
    text: "thinking about approach",
  });
});

test("request parser rejects an empty compaction", () => {
  expectRequestError({ version: 1, chunks: [] }, "empty_compaction");
});

function expectRequestError(value: unknown, code: string): void {
  try {
    parseCompactionRequest(value);
    throw new Error("expected request parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).code).toBe(code);
  }
}
