FROM oven/bun:1.3.14 AS build

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps/context-brake/package.json apps/context-brake/package.json
COPY apps/compaction-server/package.json apps/compaction-server/package.json
RUN bun install --frozen-lockfile

COPY apps/compaction-server apps/compaction-server
RUN bun run --cwd apps/compaction-server build

FROM oven/bun:1.3.14-slim

WORKDIR /app
COPY --from=build /app/apps/compaction-server/dist/server.js ./server.js

ENV COMPACTION_HOST=0.0.0.0
ENV COMPACTION_PORT=7790
EXPOSE 7790
USER bun

CMD ["bun", "server.js"]
