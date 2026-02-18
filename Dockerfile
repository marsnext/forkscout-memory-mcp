# ── Build stage ───────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# ── Runtime stage (just Node + one file) ──────
FROM node:22-alpine

WORKDIR /app

COPY --from=build /app/dist/server.mjs ./server.mjs

ENV NODE_ENV=production
ENV MEMORY_PORT=3211
ENV MEMORY_HOST=0.0.0.0
ENV MEMORY_STORAGE=/data

EXPOSE 3211

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD wget -qO- http://localhost:3211/health || exit 1

CMD ["node", "server.mjs"]
