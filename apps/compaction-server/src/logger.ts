import pino from "pino";

export const logger = pino({
  name: "context-brake-compaction-server",
  level: Bun.env.COMPACTION_LOG_LEVEL ?? "info",
});
