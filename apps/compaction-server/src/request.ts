import {
  COMPACTION_REQUEST_VERSION,
  type CompactableEvent,
  type CompactionRequest,
} from "./contract.js";
import { isObject } from "./json.js";

export const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const MAX_CHUNKS = 128;
const MAX_EVENTS_PER_CHUNK = 10_000;

export async function readCompactionRequest(request: Request): Promise<CompactionRequest> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_REQUEST_BYTES) throw new RequestError(413, "request_too_large");

  const bytes = await readBoundedBody(request);
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new RequestError(413, "request_too_large");

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestError(400, "invalid_json");
  }
  return parseCompactionRequest(value);
}

// Reads the body incrementally and bails out as soon as it exceeds the
// limit, instead of buffering an unbounded chunked-encoding body first
// (content-length is absent/unreliable for chunked transfer-encoding).
async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) throw new RequestError(413, "request_too_large");
      parts.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export function parseCompactionRequest(value: unknown): CompactionRequest {
  if (!isObject(value) || value.version !== COMPACTION_REQUEST_VERSION) {
    throw new RequestError(400, "unsupported_request_version");
  }
  if (!Array.isArray(value.chunks) || value.chunks.length > MAX_CHUNKS) {
    throw new RequestError(400, "invalid_chunks");
  }

  const chunks = value.chunks.map((chunk) => {
    if (!isObject(chunk) || !Array.isArray(chunk.events) || chunk.events.length > MAX_EVENTS_PER_CHUNK) {
      throw new RequestError(400, "invalid_chunk");
    }
    return { events: chunk.events.map(parseEvent) };
  });

  const checkpoint = value.checkpoint;
  if (checkpoint !== undefined && (typeof checkpoint !== "string" || !checkpoint.trim())) {
    throw new RequestError(400, "invalid_checkpoint");
  }
  if (chunks.every((chunk) => chunk.events.length === 0)) {
    throw new RequestError(400, "empty_compaction");
  }

  return typeof checkpoint === "string"
    ? { version: COMPACTION_REQUEST_VERSION, checkpoint, chunks }
    : { version: COMPACTION_REQUEST_VERSION, chunks };
}

function parseEvent(value: unknown): CompactableEvent {
  if (!isObject(value)) throw new RequestError(400, "invalid_event");
  if (
    value.kind === "message" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" &&
    value.text.length > 0
  ) {
    return { kind: "message", role: value.role, text: value.text };
  }
  if (
    value.kind === "tool" &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.input === "string" &&
    (value.output === undefined || typeof value.output === "string") &&
    (value.failed === undefined || typeof value.failed === "boolean")
  ) {
    const event: CompactableEvent = { kind: "tool", name: value.name, input: value.input };
    if (typeof value.output === "string") event.output = value.output;
    if (typeof value.failed === "boolean") event.failed = value.failed;
    return event;
  }
  if (
    value.kind === "reasoning" &&
    typeof value.text === "string" &&
    value.text.length > 0
  ) {
    return { kind: "reasoning", text: value.text };
  }
  throw new RequestError(400, "invalid_event");
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
