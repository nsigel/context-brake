import pino, { type DestinationStream } from "pino";

const MAX_LOG_LINES = 500;

class LogBuffer implements DestinationStream {
  private readonly lines: string[] = [];

  constructor(private readonly maximumLines = MAX_LOG_LINES) {}

  write(chunk: string): void {
    this.lines.push(...chunk.split("\n").filter(Boolean));
    if (this.lines.length > this.maximumLines) {
      this.lines.splice(0, this.lines.length - this.maximumLines);
    }
  }

  snapshot(): string {
    return this.lines.length === 0 ? "" : `${this.lines.join("\n")}\n`;
  }
}

// ponytail: keep only a 500-line tail in memory; use persistent logging for full history.
export const logBuffer = new LogBuffer();

const output = pino.destination();

const logDestination: DestinationStream & { flush: (callback?: (error?: Error) => void) => void } = {
  write(chunk) {
    logBuffer.write(chunk);
    output.write(chunk);
  },
  flush(callback) {
    output.flush(callback);
  },
};

export const logger = pino({
  name: "context-brake",
  level: Bun.env.CONTEXT_BRAKE_LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
}, logDestination);
