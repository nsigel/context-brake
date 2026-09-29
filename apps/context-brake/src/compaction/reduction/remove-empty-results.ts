import type { NormalizedEvent } from "../normalize/index.js";

export function removeEmptyToolResults(events: NormalizedEvent[]): Array<NormalizedEvent> {
  return events.map((event) => {
    if (event.kind !== "tool" || event.failed === true || event.output?.trim()) return event;
    const { output: _emptyOutput, ...toolWithoutOutput } = event;
    return toolWithoutOutput;
  });
}
