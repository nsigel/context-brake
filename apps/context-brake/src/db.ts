import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import type { Provider, ThreadRow, ThreadState, UsageSnapshot, UsageSpeed } from "./types.js";

const SCHEMA_VERSION = 4;
type NamedBindings = Record<string, string | number | null>;

export class ThreadStore {
  readonly database: Database;
  private readonly findStatement: Statement<Record<string, unknown>, [string, string]>;
  private readonly findByThreadIdStatement: Statement<Record<string, unknown>, [string]>;
  private readonly upsertStatement: Statement<Record<string, unknown>, [NamedBindings]>;
  private readonly listStatement: Statement<Record<string, unknown>, []>;
  private readonly listActiveStatement: Statement<Record<string, unknown>, []>;
  private readonly closeStatement: Statement<Record<string, unknown>, [number, string, string]>;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA busy_timeout = 250");
    this.migrate();

    this.findStatement = this.database.prepare<Record<string, unknown>, [string, string]>(`
      SELECT * FROM threads WHERE provider = ? AND thread_id = ?
    `);
    this.findByThreadIdStatement = this.database.prepare<Record<string, unknown>, [string]>(`
      SELECT * FROM threads WHERE thread_id = ? ORDER BY checked_at_ms DESC LIMIT 1
    `);
    this.listStatement = this.database.prepare<Record<string, unknown>, []>(`
      SELECT * FROM threads ORDER BY COALESCE(usage_event_at_ms, 0) DESC
    `);
    this.listActiveStatement = this.database.prepare<Record<string, unknown>, []>(`
      SELECT * FROM threads WHERE state = 'active'
      ORDER BY COALESCE(usage_event_at_ms, 0) DESC
    `);
    this.closeStatement = this.database.prepare<Record<string, unknown>, [number, string, string]>(`
      UPDATE threads SET state = 'closed', checked_at_ms = ?
      WHERE provider = ? AND thread_id = ?
    `);
    this.upsertStatement = this.database.prepare<Record<string, unknown>, NamedBindings>(`
      INSERT INTO threads (
        provider, thread_id, transcript_path, title, cwd, model, effort, speed,
        usage_event_at_ms, input_tokens_total, input_tokens_cached,
        input_tokens_cache_write, output_tokens, context_window_tokens,
        source_device, source_inode, source_size_bytes, source_mtime_ms,
        source_offset_bytes, parser_version, checked_at_ms
      ) VALUES (
        $provider, $threadId, $transcriptPath, $title, $cwd, $model, $effort, $speed,
        $usageEventAtMs, $inputTokensTotal, $inputTokensCached,
        $inputTokensCacheWrite, $outputTokens, $contextWindowTokens,
        $sourceDevice, $sourceInode, $sourceSizeBytes, $sourceMtimeMs,
        $sourceOffsetBytes, $parserVersion, $checkedAtMs
      )
      ON CONFLICT(provider, thread_id) DO UPDATE SET
        transcript_path = excluded.transcript_path,
        title = COALESCE(excluded.title, threads.title),
        cwd = COALESCE(excluded.cwd, threads.cwd),
        model = CASE WHEN $usageKind = 1 THEN excluded.model ELSE COALESCE(excluded.model, threads.model) END,
        effort = COALESCE(excluded.effort, threads.effort),
        speed = CASE WHEN $usageKind = 1 THEN excluded.speed ELSE threads.speed END,
        usage_event_at_ms = CASE WHEN $usageKind IN (1, 2) THEN excluded.usage_event_at_ms ELSE threads.usage_event_at_ms END,
        input_tokens_total = CASE WHEN $usageKind IN (1, 2) THEN excluded.input_tokens_total ELSE threads.input_tokens_total END,
        input_tokens_cached = CASE WHEN $usageKind = 1 THEN excluded.input_tokens_cached WHEN $usageKind = 2 THEN 0 ELSE threads.input_tokens_cached END,
        input_tokens_cache_write = CASE WHEN $usageKind = 1 THEN excluded.input_tokens_cache_write WHEN $usageKind = 2 THEN 0 ELSE threads.input_tokens_cache_write END,
        output_tokens = CASE WHEN $usageKind IN (1, 2) THEN excluded.output_tokens ELSE threads.output_tokens END,
        context_window_tokens = CASE
          WHEN $usageKind = 1 THEN excluded.context_window_tokens
          WHEN $usageKind = 2 THEN COALESCE(threads.context_window_tokens, excluded.context_window_tokens)
          ELSE threads.context_window_tokens
        END,
        source_device = excluded.source_device,
        source_inode = excluded.source_inode,
        source_size_bytes = excluded.source_size_bytes,
        source_mtime_ms = excluded.source_mtime_ms,
        source_offset_bytes = excluded.source_offset_bytes,
        parser_version = excluded.parser_version,
        checked_at_ms = excluded.checked_at_ms,
        state = 'active'
    `);
  }

  close(): void {
    this.database.close();
  }

  find(provider: Provider, threadId: string): ThreadRow | null {
    const row = this.findStatement.get(provider, threadId) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  findByThreadId(threadId: string): ThreadRow | null {
    const row = this.findByThreadIdStatement.get(threadId) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  list(): ThreadRow[] {
    return (this.listStatement.all() as Record<string, unknown>[]).map(mapRow);
  }

  listActive(): ThreadRow[] {
    return (this.listActiveStatement.all() as Record<string, unknown>[]).map(mapRow);
  }

  closeThread(provider: Provider, threadId: string, closedAtMs: number): void {
    this.closeStatement.run(closedAtMs, provider, threadId);
  }

  upsert(args: {
    provider: Provider;
    threadId: string;
    transcriptPath: string;
    title?: string | null;
    cwd?: string | null;
    model?: string | null;
    effort?: string | null;
    usage?: UsageSnapshot | null;
    usageKind: "invocation" | "checkpoint" | null;
    sourceDevice: number;
    sourceInode: number;
    sourceSizeBytes: number;
    sourceMtimeMs: number;
    sourceOffsetBytes: number;
    parserVersion: number;
    checkedAtMs: number;
  }): ThreadRow {
    const usage = args.usage;
    if ((usage === null || usage === undefined) !== (args.usageKind === null)) {
      throw new Error("usage and usageKind must either both be present or both be absent");
    }
    this.upsertStatement.run({
      $provider: args.provider,
      $threadId: args.threadId,
      $transcriptPath: args.transcriptPath,
      $title: args.title ?? null,
      $cwd: args.cwd ?? null,
      $model: args.model ?? usage?.model ?? null,
      $effort: args.effort ?? null,
      $speed: usage?.speed ?? null,
      $usageEventAtMs: usage?.usageEventAtMs ?? null,
      $inputTokensTotal: usage?.inputTokensTotal ?? null,
      $inputTokensCached: usage?.inputTokensCached ?? null,
      $inputTokensCacheWrite: usage?.inputTokensCacheWrite ?? null,
      $outputTokens: usage?.outputTokens ?? null,
      $contextWindowTokens: usage?.contextWindowTokens ?? null,
      $sourceDevice: args.sourceDevice,
      $sourceInode: args.sourceInode,
      $sourceSizeBytes: args.sourceSizeBytes,
      $sourceMtimeMs: args.sourceMtimeMs,
      $sourceOffsetBytes: args.sourceOffsetBytes,
      $parserVersion: args.parserVersion,
      $checkedAtMs: args.checkedAtMs,
      $usageKind: args.usageKind === "invocation" ? 1 : args.usageKind === "checkpoint" ? 2 : 0,
    });
    const saved = this.find(args.provider, args.threadId);
    if (!saved) throw new Error("Thread upsert did not produce a row");
    return saved;
  }

  private migrate(): void {
    const version = Number(
      this.database.prepare<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0,
    );
    if (version > SCHEMA_VERSION) {
      throw new Error(`Database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    if (version === 0) {
      this.database.exec(`
        CREATE TABLE threads (
          provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
          thread_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'closed')),
          transcript_path TEXT NOT NULL,
          title TEXT,
          cwd TEXT,
          model TEXT,
          effort TEXT,
          speed TEXT CHECK (speed IN ('standard', 'fast')),
          usage_event_at_ms INTEGER,
          input_tokens_total INTEGER,
          input_tokens_cached INTEGER,
          input_tokens_cache_write INTEGER,
          output_tokens INTEGER,
          context_window_tokens INTEGER,
          source_device INTEGER,
          source_inode INTEGER,
          source_size_bytes INTEGER,
          source_mtime_ms INTEGER,
          source_offset_bytes INTEGER,
          parser_version INTEGER,
          checked_at_ms INTEGER,
          PRIMARY KEY (provider, thread_id)
        ) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      return;
    }
    if (version === 1) {
      this.database.exec(`
        ALTER TABLE threads ADD COLUMN speed TEXT CHECK (speed IN ('standard', 'fast'));
        PRAGMA user_version = 2;
      `);
    }
    if (version <= 2) {
      this.database.exec(`
        ALTER TABLE threads ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
          CHECK (state IN ('active', 'closed'));
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    }
    if (version <= 3) {
      this.database.exec(`
        ALTER TABLE threads ADD COLUMN effort TEXT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    }
  }
}

function integer(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;
}

function text(row: Record<string, unknown>, key: string): string | null {
  return typeof row[key] === "string" ? row[key] : null;
}

function mapRow(row: Record<string, unknown>): ThreadRow {
  return {
    provider: text(row, "provider") as Provider,
    threadId: text(row, "thread_id") ?? "",
    state: threadState(row, "state"),
    transcriptPath: text(row, "transcript_path") ?? "",
    title: text(row, "title"),
    cwd: text(row, "cwd"),
    model: text(row, "model"),
    effort: text(row, "effort"),
    speed: usageSpeed(row, "speed"),
    usageEventAtMs: integer(row, "usage_event_at_ms"),
    inputTokensTotal: integer(row, "input_tokens_total"),
    inputTokensCached: integer(row, "input_tokens_cached"),
    inputTokensCacheWrite: integer(row, "input_tokens_cache_write"),
    outputTokens: integer(row, "output_tokens"),
    contextWindowTokens: integer(row, "context_window_tokens"),
    sourceDevice: integer(row, "source_device"),
    sourceInode: integer(row, "source_inode"),
    sourceSizeBytes: integer(row, "source_size_bytes"),
    sourceMtimeMs: integer(row, "source_mtime_ms"),
    sourceOffsetBytes: integer(row, "source_offset_bytes"),
    parserVersion: integer(row, "parser_version"),
    checkedAtMs: integer(row, "checked_at_ms"),
  };
}

function threadState(row: Record<string, unknown>, key: string): ThreadState {
  return text(row, key) === "closed" ? "closed" : "active";
}

function usageSpeed(row: Record<string, unknown>, key: string): UsageSpeed | null {
  const value = text(row, key);
  return value === "standard" || value === "fast" ? value : null;
}
