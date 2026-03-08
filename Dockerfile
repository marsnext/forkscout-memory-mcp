# ── Debian-based Bun (glibc required for onnxruntime-node native bindings) ──
FROM oven/bun:1

LABEL org.opencontainers.image.source="https://github.com/martianacademy/forkscout-memory-mcp"
LABEL org.opencontainers.image.description="Persistent memory MCP server for AI agents - knowledge graph, vector search, structured facts"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src/ ./src/

ENV NODE_ENV=production
ENV MEMORY_PORT=3211
ENV MEMORY_HOST=0.0.0.0
ENV MEMORY_STORAGE=/data
# Model cache inside the data volume so it persists across container rebuilds
ENV TRANSFORMERS_CACHE=/data/.transformers-cache

EXPOSE 3211

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3211/health || exit 1

CMD ["bun", "run", "src/server.ts"]
