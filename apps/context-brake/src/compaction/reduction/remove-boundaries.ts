import type { NormalizedEvent } from "../normalize/index.js";

export function removeBoundaries(events: NormalizedEvent[]): Array<NormalizedEvent> {
  return events.filter((event) => event.kind !== "boundary");
}
