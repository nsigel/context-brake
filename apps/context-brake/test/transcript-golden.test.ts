import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { loadPolicy } from "../src/policy.js";
import { createApp } from "../src/server.js";
import type { Provider } from "../src/types.js";

// Frozen wall clock. Stale fixtures record usage 6h earlier (past the 1h cache
// TTL); fresh fixtures record it 5m earlier (inside the TTL).
const NOW = Date.parse("2026-08-10T18:00:00.000Z");
const FIXTURES = resolve(import.meta.dir, "fixtures");
const POLICY = loadPolicy();
// The Codex adapter curls with --max-time 0.3; a slower decision would time out
// and fail open, so the brake would silently never reach the user.
const HOOK_TIMEOUT_MS = 300;

const MODEL: Record<Provider, string> = {
  codex: "gpt-5.6-sol",
  claude: "claude-sonnet-5",
};

interface Case {
  name: string;
  provider: Provider;
  fixture: string | null; // null => point at a missing file
  status: number;
  golden?: string;
  measureLatency?: boolean;
}

const CASES: Case[] = [
  { name: "codex stale expensive blocks", provider: "codex", fixture: "codex-stale.jsonl", status: 200, golden: "codex-stale.json", measureLatency: true },
  { name: "claude stale expensive blocks once", provider: "claude", fixture: "claude-stale.jsonl", status: 200, golden: "claude-stale.json", measureLatency: true },
  { name: "codex fresh continues", provider: "codex", fixture: "codex-fresh.jsonl", status: 204 },
  { name: "claude fresh continues", provider: "claude", fixture: "claude-fresh.jsonl", status: 204 },
  { name: "codex missing transcript continues", provider: "codex", fixture: null, status: 204 },
  { name: "claude malformed transcript continues", provider: "claude", fixture: "claude-malformed.jsonl", status: 204 },
];

async function bootApp() {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-golden-"));
  const app = createApp({
    now: () => NOW,
    policy: POLICY,
    databasePath: join(directory, "test.sqlite"),
    hostname: "127.0.0.1",
    port: 0,
  });
  return { app, directory };
}

function transcriptPathFor(directory: string, fixture: string | null): string {
  return fixture ? join(FIXTURES, fixture) : join(directory, "does-not-exist.jsonl");
}

for (const testCase of CASES) {
  test(testCase.name, async () => {
    const { app, directory } = await bootApp();
    try {
      const payload = JSON.stringify({
        session_id: `${testCase.provider}-golden`,
        transcript_path: transcriptPathFor(directory, testCase.fixture),
        cwd: directory,
        model: MODEL[testCase.provider],
        prompt: "continue",
      });

      const startedAt = performance.now();
      const response = await fetch(`${app.url}v1/hooks/${testCase.provider}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      const latencyMs = performance.now() - startedAt;

      expect(response.status).toBe(testCase.status);

      if (testCase.status === 200 && testCase.golden) {
        const body = await response.json();
        const goldenPath = join(FIXTURES, "golden", testCase.golden);
        if (Bun.env.GOLDEN_UPDATE || !existsSync(goldenPath)) {
          writeFileSync(goldenPath, `${JSON.stringify(body, null, 2)}\n`);
        }
        const expected = JSON.parse(readFileSync(goldenPath, "utf8"));
        expect(body).toEqual(expected);
        // Exactly one persisted row for the observed thread.
        expect(app.store.list().length).toBe(1);
      } else {
        expect(await response.text()).toBe("");
      }

      if (testCase.measureLatency) {
        console.log(`[latency] ${testCase.name}: ${latencyMs.toFixed(1)}ms (budget ${HOOK_TIMEOUT_MS}ms)`);
        expect(latencyMs).toBeLessThan(HOOK_TIMEOUT_MS);
      }
    } finally {
      await app.stop();
    }
  });
}

// Layer B: the Codex shell adapter against the REAL backend (existing
// hooks.test.ts only exercises the adapter against a fake server).
const ADAPTER = resolve("apps/context-brake/hooks/codex-user-prompt-submit.sh");

async function runAdapter(baseUrl: string, transcriptPath: string) {
  const process = Bun.spawn([ADAPTER], {
    env: { ...Bun.env, CONTEXT_BRAKE_API_URL: baseUrl, CONTEXT_BRAKE_HOOK_TIMEOUT_SECONDS: "1" },
    stdin: new Blob([
      JSON.stringify({
        session_id: "codex-adapter",
        transcript_path: transcriptPath,
        cwd: "/tmp",
        model: MODEL.codex,
        prompt: "continue",
      }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  return { exitCode, stdout };
}

test("Codex adapter blocks once, then allows a resend", async () => {
  const { app } = await bootApp();
  try {
    const result = await runAdapter(app.url.replace(/\/$/, ""), join(FIXTURES, "codex-stale.jsonl"));
    expect(result.exitCode).toBe(0);
    const golden = JSON.parse(readFileSync(join(FIXTURES, "golden", "codex-stale.json"), "utf8"));
    const adapterGolden = {
      ...golden,
      reason: golden.reason.replace("relay codex-golden", "relay codex-adapter"),
    };
    expect(JSON.parse(result.stdout)).toEqual(adapterGolden);

    const resent = await runAdapter(app.url.replace(/\/$/, ""), join(FIXTURES, "codex-stale.jsonl"));
    expect(resent).toEqual({ exitCode: 0, stdout: "" });

    const blockedAgain = await runAdapter(app.url.replace(/\/$/, ""), join(FIXTURES, "codex-stale.jsonl"));
    expect(blockedAgain.exitCode).toBe(0);
    expect(JSON.parse(blockedAgain.stdout)).toEqual(adapterGolden);
  } finally {
    await app.stop();
  }
});

test("Codex adapter prints nothing for a fresh thread through the real backend", async () => {
  const { app } = await bootApp();
  try {
    const result = await runAdapter(app.url.replace(/\/$/, ""), join(FIXTURES, "codex-fresh.jsonl"));
    expect(result).toEqual({ exitCode: 0, stdout: "" });
  } finally {
    await app.stop();
  }
});

test("Codex adapter fails open when the backend is down", async () => {
  const result = await runAdapter("http://127.0.0.1:1", join(FIXTURES, "codex-stale.jsonl"));
  expect(result).toEqual({ exitCode: 0, stdout: "" });
});

test("Claude stale prompt blocks once, then allows a resend", async () => {
  let now = NOW;
  const directory = await mkdtemp(join(tmpdir(), "context-brake-claude-retry-"));
  const transcript = join(FIXTURES, "claude-stale.jsonl");
  const app = createApp({
    now: () => now,
    policy: POLICY,
    databasePath: join(directory, "test.sqlite"),
    hostname: "127.0.0.1",
    port: 0,
  });

  try {
    const submit = (transcriptPath = transcript) => fetch(`${app.url}v1/hooks/claude`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "claude-warning-once",
        hook_event_name: "UserPromptSubmit",
        transcript_path: transcriptPath,
        cwd: directory,
        model: MODEL.claude,
        prompt: "normal prompt",
      }),
    });

    const first = await submit();
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { decision?: string; reason?: string };
    expect(firstBody.decision).toBe("block");
    expect(firstBody.reason).toMatch(/Resubmit the prompt to continue/);

    const second = await submit();
    expect(second.status).toBe(204);

    const third = await submit();
    expect(third.status).toBe(200);

    const updatedTranscript = join(directory, "session.jsonl");
    await Bun.write(updatedTranscript, await Bun.file(transcript).text());
    await appendFile(updatedTranscript, `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-10T17:00:00.000Z",
      message: {
        model: MODEL.claude,
        usage: { input_tokens: 120000, output_tokens: 1000 },
      },
    })}\n`);
    now = Date.parse("2026-08-10T17:30:00.000Z");

    const fresh = await fetch(`${app.url}v1/hooks/claude`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "claude-warning-once",
        hook_event_name: "UserPromptSubmit",
        transcript_path: updatedTranscript,
        cwd: directory,
        model: MODEL.claude,
        prompt: "normal prompt",
      }),
    });
    expect(fresh.status).toBe(204);

    now = Date.parse("2026-08-10T19:00:00.000Z");
    const staleAgain = await submit(updatedTranscript);
    expect(staleAgain.status).toBe(200);
  } finally {
    await app.stop();
  }
});
