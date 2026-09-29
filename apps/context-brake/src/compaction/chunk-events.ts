import type { CompactionChunk, CompactableEvent } from "./contract.js";

export function chunkEvents(
  events: CompactableEvent[],
  maximumCharacters: number,
): CompactionChunk[] {
  if (!Number.isFinite(maximumCharacters) || maximumCharacters <= 0) {
    throw new RangeError("maximumCharacters must be greater than zero");
  }
  if (events.length === 0) return [];

  const chunks: CompactionChunk[] = [];
  let current: CompactableEvent[] = [];
  let currentCharacters = 0;

  for (const event of events) {
    const characters = JSON.stringify(event).length;
    if (current.length > 0 && currentCharacters + characters > maximumCharacters) {
      chunks.push({ events: current });
      current = [];
      currentCharacters = 0;
    }
    current.push(event);
    currentCharacters += characters;
  }

  if (current.length > 0) chunks.push({ events: current });
  return chunks;
}
