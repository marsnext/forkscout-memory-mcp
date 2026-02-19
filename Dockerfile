# ── Single-stage Bun — runs TypeScript natively ──
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src/ ./src/

ENV NODE_ENV=production
ENV MEMORY_PORT=3211
ENV MEMORY_HOST=0.0.0.0
ENV MEMORY_STORAGE=/data

EXPOSE 3211

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD bun -e "const r=await fetch('http://localhost:3211/health');if(!r.ok)process.exit(1)" || exit 1

CMD ["bun", "run", "src/server.ts"]
