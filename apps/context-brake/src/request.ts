import type { HookInput } from "./types.js";

const MAX_HOOK_BYTES = 2 * 1024 * 1024;

export async function readHookInput(request: Request): Promise<HookInput> {
  const value = await readLimitedJson(request, MAX_HOOK_BYTES);
  if (!isObject(value) || typeof value.session_id !== "string" || !value.session_id) {
    throw new Error("Hook request requires a non-empty session_id");
  }

  const hookEventName = optionalString(value, "hook_event_name");
  const reason = optionalString(value, "reason");
  const transcriptPath = optionalNullableString(value, "transcript_path");
  const cwd = optionalString(value, "cwd");
  const model = optionalString(value, "model");
  const effort = optionalString(value, "effort")
    ?? optionalString(value, "reasoning_effort")
    ?? optionalString(value, "model_reasoning_effort");
  const prompt = optionalString(value, "prompt");
  const turnId = optionalString(value, "turn_id");

  return {
    session_id: value.session_id,
    ...(hookEventName !== undefined ? { hook_event_name: hookEventName } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(transcriptPath !== undefined ? { transcript_path: transcriptPath } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(turnId !== undefined ? { turn_id: turnId } : {}),
  };
}

async function readLimitedJson(request: Request, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Hook request exceeds ${maximumBytes} bytes`);
  }

  const reader = request.body?.getReader();
  if (!reader) throw new Error("Hook request body is required");

  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error(`Hook request exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field !== undefined && typeof field !== "string") {
    throw new Error(`Hook request field ${key} must be a string`);
  }
  return field;
}

function optionalNullableString(
  value: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const field = value[key];
  if (field !== undefined && field !== null && typeof field !== "string") {
    throw new Error(`Hook request field ${key} must be a string or null`);
  }
  return field;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
