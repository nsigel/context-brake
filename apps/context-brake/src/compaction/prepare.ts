import {
  type CompactionChunk,
  type CompactionRequest,
  COMPACTION_REQUEST_VERSION,
} from "./contract.js";
import { chunkEvents } from "./chunk-events.js";
import {
  normalizeTranscript,
  type NormalizedEvent,
  type TranscriptProvider,
} from "./normalize/index.js";
import { reduceTranscript, type ReductionOptions } from "./reduction/reduce.js";

const DEFAULT_CHUNK_CHARACTERS = 400_000;

export interface PreparationOptions {
  maximumChunkCharacters?: number;
  reduction?: ReductionOptions;
  onStage?: (stage: "normalizing" | "reducing") => void;
}

export function prepareCompaction(
  raw: string,
  provider: TranscriptProvider,
  options: PreparationOptions = {},
): CompactionRequest {
  options.onStage?.("normalizing");
  const events = normalizeTranscript(raw, provider);
  options.onStage?.("reducing");
  const maximumChunkCharacters = options.maximumChunkCharacters ?? DEFAULT_CHUNK_CHARACTERS;

  if (provider === "claude") {
    return prepareClaude(events, maximumChunkCharacters, options.reduction);
  }
  return prepareCodex(events, maximumChunkCharacters, options.reduction);
}

export function relayPrompt(summary: string): string {
  return [
    "You are continuing an existing software-engineering task.",
    "",
    "<checkpoint>",
    summary.trimEnd(),
    "</checkpoint>",
    "",
    "The working directory contains the implementation state from the previous session.",
    "Continue from that state, complete the task, and run the relevant tests.",
    "",
  ].join("\n");
}

function prepareClaude(
  events: NormalizedEvent[],
  maximumChunkCharacters: number,
  reductionOptions: ReductionOptions | undefined,
): CompactionRequest {
  const boundaryIndex = findLatestSummaryBoundary(events);
  const checkpoint = boundaryIndex >= 0
    ? (events[boundaryIndex] as Extract<NormalizedEvent, { kind: "boundary" }>).summary
    : undefined;
  const selected = boundaryIndex >= 0 ? events.slice(boundaryIndex + 1) : events;
  const chunks = reduceAndChunk([selected], maximumChunkCharacters, reductionOptions);
  return checkpoint
    ? { version: COMPACTION_REQUEST_VERSION, checkpoint, chunks }
    : { version: COMPACTION_REQUEST_VERSION, chunks };
}

function prepareCodex(
  events: NormalizedEvent[],
  maximumChunkCharacters: number,
  reductionOptions: ReductionOptions | undefined,
): CompactionRequest {
  return {
    version: COMPACTION_REQUEST_VERSION,
    chunks: reduceAndChunk(splitAtBoundaries(events), maximumChunkCharacters, reductionOptions),
  };
}

function findLatestSummaryBoundary(events: NormalizedEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "boundary" && event.summary) return index;
  }
  return -1;
}

function splitAtBoundaries(events: NormalizedEvent[]): NormalizedEvent[][] {
  const groups: NormalizedEvent[][] = [];
  let current: NormalizedEvent[] = [];
  for (const event of events) {
    if (event.kind === "boundary") {
      if (current.length > 0) groups.push(current);
      current = [];
    } else {
      current.push(event);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function reduceAndChunk(
  groups: NormalizedEvent[][],
  maximumChunkCharacters: number,
  reductionOptions: ReductionOptions | undefined,
): CompactionChunk[] {
  const chunks: CompactionChunk[] = [];
  for (const group of groups) {
    const reduced = reductionOptions
      ? reduceTranscript(group, reductionOptions)
      : reduceTranscript(group);
    chunks.push(...chunkEvents(reduced, maximumChunkCharacters));
  }
  return chunks;
}
