export type NormalizedEvent =
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
    }
  | {
      kind: "runtime_instructions";
      text: string;
    }
  | {
      kind: "boundary";
      summary?: string;
    };

export type NormalizedToolEvent = Extract<NormalizedEvent, { kind: "tool" }>;
