# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS base
WORKDIR /app
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Development: dependencies baked in, source mounted by compose.dev.yaml.
FROM base AS dev
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
CMD ["sh", "-c", "bun scripts/build-web.ts && bun --watch src/server/main.ts"]

FROM dev AS build
COPY . .
RUN bun scripts/build-web.ts

# Production: the server needs no packages at runtime; the client is prebuilt.
FROM base AS prod
COPY package.json ./
COPY config ./config
COPY src ./src
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 8080
CMD ["bun", "src/server/main.ts"]
