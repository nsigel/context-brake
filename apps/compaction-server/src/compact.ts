import type { CompactionRequest, CompactionResponse } from "./contract.js";
import { compactionInput, COMPACTION_SYSTEM_PROMPT } from "./prompt.js";

export interface ModelCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  reasoningCharacters: number;
}

export type CompleteCompaction = (
  systemPrompt: string,
  input: string,
) => Promise<ModelCompletion>;

export async function compact(
  request: CompactionRequest,
  complete: CompleteCompaction,
): Promise<CompactionResponse> {
  let summary = request.checkpoint ?? "";
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningCharacters = 0;
  const chunks = [];

  for (const [index, chunk] of request.chunks.entries()) {
    const completion = await complete(
      COMPACTION_SYSTEM_PROMPT,
      compactionInput(summary || undefined, chunk),
    );
    summary = completion.text;
    inputTokens += completion.inputTokens;
    outputTokens += completion.outputTokens;
    reasoningCharacters += completion.reasoningCharacters;
    chunks.push({
      index,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      reasoningCharacters: completion.reasoningCharacters,
    });
  }

  return {
    summary,
    usage: {
      invocations: request.chunks.length,
      inputTokens,
      outputTokens,
      reasoningCharacters,
      chunks,
    },
  };
}
