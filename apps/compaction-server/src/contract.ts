export const COMPACTION_REQUEST_VERSION = 1 as const;

export type CompactableEvent =
  | {
      kind: "message";
      role: "user" | "assistant";
      text: string;
    }
  | {
      kind: "tool";
      name: string;
      input: string;
      output?: string;
      failed?: boolean;
    }
  | {
      kind: "reasoning";
      text: string;
    };

export interface CompactionChunk {
  events: CompactableEvent[];
}

export interface CompactionRequest {
  version: typeof COMPACTION_REQUEST_VERSION;
  checkpoint?: string;
  chunks: CompactionChunk[];
}

export interface CompactionChunkUsage {
  index: number;
  inputTokens: number;
  outputTokens: number;
  reasoningCharacters: number;
}

export interface CompactionResponse {
  summary: string;
  costUsd?: number | null;
  usage: {
    invocations: number;
    inputTokens: number;
    outputTokens: number;
    reasoningCharacters: number;
    chunks: CompactionChunkUsage[];
  };
}
