import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  completeWithDeepSeek,
  deepSeekRequest,
  parseDeepSeekStream,
} from "../src/bedrock.js";

const golden = join(import.meta.dir, "golden");

test("DeepSeek Mantle request matches the golden envelope", () => {
  const expected = JSON.parse(readFileSync(join(golden, "deepseek-request.json"), "utf8"));
  expect(deepSeekRequest("compact carefully", "conversation data", "deepseek.v3.2", 8_000))
    .toEqual(expected);
});

test("DeepSeek Mantle stream separates reasoning and summary", async () => {
  const stream = sse([
    { choices: [{ delta: { role: "assistant", reasoning: "check " } }] },
    { choices: [{ delta: { reasoning_content: "facts" } }] },
    { choices: [{ delta: { content: " ready " } }] },
    { choices: [], usage: { prompt_tokens: 13, completion_tokens: 8 } },
  ]);
  expect(await parseDeepSeekStream(stream)).toEqual({
    text: "ready",
    inputTokens: 13,
    outputTokens: 8,
    reasoningCharacters: 11,
  });
});

test("DeepSeek Mantle request is SigV4 signed", async () => {
  let authorization = "";
  const complete = completeWithDeepSeek(
    { accessKeyId: "test", secretAccessKey: "secret" },
    {
      awsRegion: "us-east-1",
      modelId: "deepseek.v3.2",
      maximumOutputTokens: 8_000,
      fetch: (async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(sseText([
          { choices: [{ delta: { content: "ready" } }] },
          { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } },
        ]));
      }) as typeof fetch,
    },
  );

  expect((await complete("system", "input")).text).toBe("ready");
  expect(authorization).toContain("Credential=test/");
  expect(authorization).toContain("/bedrock-mantle/aws4_request");
});

test("DeepSeek Mantle stream rejects a response without summary text", async () => {
  const stream = sse([
    { choices: [{ delta: { reasoning: "only thoughts" } }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } },
  ]);
  expect(parseDeepSeekStream(stream)).rejects.toThrow("did not contain summary text");
});

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(sseText(events));
  return new ReadableStream({
    start(controller) {
      const split = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
}

function sseText(events: unknown[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}
