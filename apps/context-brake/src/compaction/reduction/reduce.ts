import type { CompactableEvent } from "../contract.js";
import type { NormalizedEvent } from "../normalize/index.js";
import { removeBoundaries } from "./remove-boundaries.js";
import { collapseSupersededReads } from "./collapse-duplicate-reads.js";
import { removeEmptyToolResults } from "./remove-empty-results.js";
import { removeRuntimeInstructions } from "./remove-runtime-instructions.js";
import { stripToolInput } from "./strip-tool-input.js";
import { trimToolOutput } from "./trim-tool-output.js";

const DEFAULT_SUCCESSFUL_OUTPUT_CHARACTERS = 2_000;
const DEFAULT_FAILED_OUTPUT_CHARACTERS = 8_000;

export interface ReductionOptions {
  successfulToolOutputCharacters?: number;
  failedToolOutputCharacters?: number;

  // Structural cleanup defaults on; lossy reductions are opt-in.
  removeRuntimeInstructions?: boolean;
  removeBoundaries?: boolean;
  removeEmptyResults?: boolean;
  collapseSupersededReads?: boolean;
  stripToolInput?: boolean;
  trimToolOutput?: boolean;
}

export function reduceTranscript(
  events: NormalizedEvent[],
  options: ReductionOptions = {},
): CompactableEvent[] {
  let reduced: NormalizedEvent[] = events;
  if (options.removeRuntimeInstructions !== false) reduced = removeRuntimeInstructions(reduced);
  if (options.removeBoundaries !== false) reduced = removeBoundaries(reduced);
  if (options.removeEmptyResults !== false) reduced = removeEmptyToolResults(reduced);
  if (options.collapseSupersededReads === true) reduced = collapseSupersededReads(reduced);
  if (options.stripToolInput === true) reduced = stripToolInput(reduced);
  if (options.trimToolOutput === true) {
    reduced = trimToolOutput(reduced, {
      successfulOutputCharacters:
        options.successfulToolOutputCharacters ?? DEFAULT_SUCCESSFUL_OUTPUT_CHARACTERS,
      failedOutputCharacters:
        options.failedToolOutputCharacters ?? DEFAULT_FAILED_OUTPUT_CHARACTERS,
    });
  }
  return asCompactableEvents(reduced);
}

function asCompactableEvents(events: NormalizedEvent[]): CompactableEvent[] {
  return events.filter(
    (event): event is CompactableEvent =>
      event.kind === "message" || event.kind === "tool" || event.kind === "reasoning",
  );
}
