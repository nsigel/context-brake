import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { logger } from "../src/logger.js";
import { createApp } from "../src/server.js";

test("healthz reports the actual loopback server endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-brake-status-"));
  const app = createApp({
    databasePath: join(directory, "test.sqlite"),
    hostname: "127.0.0.1",
    port: 0,
  });

  try {
    const response = await fetch(`${app.url}healthz`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(body).toMatchObject({
      ok: true,
      service: "context-brake",
      url: app.url,
      host: "127.0.0.1",
      port: Number(new URL(app.url).port),
    });

    logger.info("server status log endpoint test");
    const logsResponse = await fetch(`${app.url}v1/logs`);
    expect(logsResponse.status).toBe(200);
    expect(logsResponse.headers.get("content-type")).toContain("application/x-ndjson");
    const logLines = (await logsResponse.text()).trim().split("\n");
    const statusLog = logLines.map((line) => JSON.parse(line)).find((record) => record.msg === "server status log endpoint test");

    expect(statusLog).toBeDefined();
    expect(statusLog.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    await app.stop();
  }
});
