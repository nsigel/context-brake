import type { NormalizedEvent } from "../normalize/index.js";

export function removeRuntimeInstructions(events: NormalizedEvent[]): Array<NormalizedEvent> {
  return events.filter((event) => event.kind !== "runtime_instructions");
}
