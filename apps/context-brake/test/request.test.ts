import { expect, test } from "bun:test";
import { readHookInput } from "../src/request.js";

test("readHookInput validates and selects the supported hook fields", async () => {
  const request = new Request("http://localhost/v1/hooks/codex", {
    method: "POST",
    body: JSON.stringify({
      session_id: "thread-1",
      hook_event_name: "SessionEnd",
      reason: "exit",
      transcript_path: null,
      effort: "high",
      prompt: "continue",
      provider_extension: { ignored: true },
    }),
  });

  expect(await readHookInput(request)).toEqual({
    session_id: "thread-1",
    hook_event_name: "SessionEnd",
    reason: "exit",
    transcript_path: null,
    effort: "high",
    prompt: "continue",
  });
});

test("readHookInput rejects fields with the wrong runtime type", async () => {
  const request = new Request("http://localhost/v1/hooks/codex", {
    method: "POST",
    body: JSON.stringify({ session_id: "thread-1", prompt: 42 }),
  });

  expect(readHookInput(request)).rejects.toThrow("prompt must be a string");
});

test("readHookInput enforces the body limit without relying on content-length", async () => {
  const encoder = new TextEncoder();
  const prefix = encoder.encode('{"session_id":"thread-1","prompt":"');
  const payload = encoder.encode("x".repeat(2 * 1024 * 1024));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      controller.enqueue(payload);
      controller.close();
    },
  });
  const request = new Request("http://localhost/v1/hooks/codex", {
    method: "POST",
    body,
    duplex: "half",
  });

  expect(readHookInput(request)).rejects.toThrow("Hook request exceeds");
});
