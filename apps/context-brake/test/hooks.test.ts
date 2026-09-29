import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const adapter = resolve("apps/context-brake/hooks/codex-user-prompt-submit.sh");
const nativePayload = JSON.stringify({
  session_id: "test-session",
  transcript_path: "/tmp/test-rollout.jsonl",
  cwd: "/tmp/project",
  hook_event_name: "UserPromptSubmit",
  model: "gpt-5.6-sol",
  turn_id: "test-turn",
  prompt: "continue",
});

test("Codex adapter posts the native payload and prints a block body unchanged", async () => {
  const blockBody = '{"decision":"block","reason":"Context Brake test"}\n';
  const capture: {
    request?: { method: string; path: string; contentType: string | null; body: string };
  } = {};
  const server = Bun.serve({
    port: 0,
    async fetch(incoming) {
      capture.request = {
        method: incoming.method,
        path: new URL(incoming.url).pathname,
        contentType: incoming.headers.get("content-type"),
        body: await incoming.text(),
      };
      return new Response(blockBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    const result = await runAdapter(server.url.toString().replace(/\/$/, ""));
    expect(result).toEqual({ exitCode: 0, stdout: blockBody, stderr: "" });
    expect(capture.request).toEqual({
      method: "POST",
      path: "/v1/hooks/codex",
      contentType: "application/json",
      body: nativePayload,
    });
  } finally {
    await server.stop(true);
  }
});

test("Codex adapter prints nothing for a 204 response", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(null, { status: 204 });
    },
  });

  try {
    expect(await runAdapter(server.url.toString().replace(/\/$/, ""))).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  } finally {
    await server.stop(true);
  }
});

test("Codex adapter fails open when the backend is unavailable", async () => {
  expect(await runAdapter("http://127.0.0.1:1")).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});

test("Claude example uses direct prompt, stop, and session-end HTTP hooks", async () => {
  const config = JSON.parse(await readFile("apps/context-brake/examples/claude-settings.json", "utf8"));
  const expected = [
    {
      hooks: [
        {
          type: "http",
          url: "http://127.0.0.1:7788/v1/hooks/claude",
          timeout: 1,
        },
      ],
    },
  ];
  expect(config.hooks.UserPromptSubmit).toEqual(expected);
  expect(config.hooks.Stop).toEqual(expected);
  expect(config.hooks.SessionEnd).toEqual(expected);
});

test("Codex example points to the command adapter", async () => {
  const config = JSON.parse(await readFile("apps/context-brake/examples/codex-hooks.json", "utf8"));
  const expected = {
    type: "command",
    command: "/absolute/path/to/context-brake/apps/context-brake/hooks/codex-user-prompt-submit.sh",
    timeout: 1,
  };
  expect(config.hooks.UserPromptSubmit[0].hooks[0]).toEqual(expected);
  expect(config.hooks.Stop[0].hooks[0]).toEqual(expected);
  expect(config.hooks.SessionEnd[0].hooks[0]).toEqual(expected);
});

async function runAdapter(baseUrl: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const process = Bun.spawn([adapter], {
    env: {
      ...Bun.env,
      CONTEXT_BRAKE_API_URL: baseUrl,
      CONTEXT_BRAKE_HOOK_TIMEOUT_SECONDS: "1",
    },
    stdin: new Blob([nativePayload]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
