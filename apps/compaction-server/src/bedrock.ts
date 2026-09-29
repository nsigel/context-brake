import { createHash, createHmac } from "node:crypto";
import { SignatureV4 } from "@smithy/signature-v4";
import type { CompleteCompaction, ModelCompletion } from "./compact.js";
import { isObject } from "./json.js";

type Credentials = ConstructorParameters<typeof SignatureV4>[0]["credentials"];

export interface BedrockMantleOptions {
  awsRegion: string;
  modelId: string;
  maximumOutputTokens: number;
  fetch?: typeof fetch;
}

export function completeWithDeepSeek(
  credentials: Credentials,
  options: BedrockMantleOptions,
): CompleteCompaction {
  const hostname = `bedrock-mantle.${options.awsRegion}.api.aws`;
  const path = "/v1/chat/completions";
  const signer = new SignatureV4({
    credentials,
    region: options.awsRegion,
    service: "bedrock-mantle",
    sha256: Sha256,
  });
  const request = options.fetch ?? fetch;

  return async (systemPrompt, input) => {
    const body = JSON.stringify(
      deepSeekRequest(systemPrompt, input, options.modelId, options.maximumOutputTokens),
    );
    const signed = await signer.sign({
      method: "POST",
      protocol: "https:",
      hostname,
      path,
      headers: { "content-type": "application/json", host: hostname },
      body,
    });
    const response = await request(`https://${hostname}${path}`, {
      method: signed.method,
      headers: signed.headers,
      body,
    });
    if (!response.ok) {
      throw new Error(`Bedrock Mantle returned ${response.status}: ${await response.text()}`);
    }
    if (!response.body) throw new Error("Bedrock Mantle returned an empty response");
    return parseDeepSeekStream(response.body);
  };
}

export function deepSeekRequest(
  systemPrompt: string,
  input: string,
  modelId: string,
  maximumOutputTokens: number,
): Record<string, unknown> {
  return {
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: input },
    ],
    max_tokens: maximumOutputTokens,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    stream: true,
    stream_options: { include_usage: true },
  };
}

export async function parseDeepSeekStream(
  stream: ReadableStream<Uint8Array>,
): Promise<ModelCompletion> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let text = "";
  let reasoningCharacters = 0;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  const consume = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const event: unknown = JSON.parse(data);
    if (!isObject(event)) throw new Error("Bedrock Mantle returned a non-object event");
    if (isObject(event.error)) {
      const message = typeof event.error.message === "string" ? event.error.message : data;
      throw new Error(`Bedrock Mantle stream failed: ${message}`);
    }

    const choices = event.choices;
    const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
    const delta = isObject(firstChoice) ? firstChoice.delta : undefined;
    if (isObject(delta)) {
      if (typeof delta.content === "string") text += delta.content;
      const reasoning =
        typeof delta.reasoning === "string"
          ? delta.reasoning
          : typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : "";
      reasoningCharacters += reasoning.length;
    }

    if (isObject(event.usage)) {
      inputTokens = finiteNumber(event.usage.prompt_tokens, "prompt_tokens");
      outputTokens = finiteNumber(event.usage.completion_tokens, "completion_tokens");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) consume(line.replace(/\r$/, ""));
    if (done) break;
  }
  if (buffered) consume(buffered.replace(/\r$/, ""));

  const trimmed = text.trim();
  if (!trimmed) throw new Error("Bedrock Mantle response did not contain summary text");
  if (inputTokens === undefined || outputTokens === undefined) {
    throw new Error("Bedrock Mantle response did not contain usage");
  }
  return { text: trimmed, inputTokens, outputTokens, reasoningCharacters };
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Bedrock Mantle response had invalid ${field}`);
  }
  return value;
}

type SourceData = string | ArrayBuffer | ArrayBufferView;

class Sha256 {
  private readonly hash;

  constructor(secret?: SourceData) {
    this.hash = secret === undefined
      ? createHash("sha256")
      : createHmac("sha256", bytes(secret));
  }

  update(value: SourceData): void {
    this.hash.update(bytes(value));
  }

  async digest(): Promise<Uint8Array> {
    return this.hash.digest();
  }
}

function bytes(value: SourceData): Uint8Array {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
