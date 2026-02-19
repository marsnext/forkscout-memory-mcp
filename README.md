# forkscout-memory-mcp

Standalone MCP (Model Context Protocol) server for persistent AI agent memory — knowledge graph, conversation history, active task tracking, and self-identity.

Lightweight, independent service. No agent, no LLM, no Playwright. Persists everything to a single `memory.json` file. Runs on **Bun** for fast startup and native TypeScript execution.

## Features

- **19 MCP tools** exposed over Streamable HTTP (stateless, one request = one response)
- **Knowledge graph** — entities with structured facts (confidence scores, source tracking), relations, and full-text search
- **Conversation memory** — exchange tracking with search
- **Active task tracking** — start, complete, abort, heartbeat, auto-expire
- **Self-identity** — agent self-entity with observation recording
- **Memory intelligence** — contradiction detection, usage tracking, confidence decay, automated consolidation
- **Two-tier consolidation** — light (confidence refresh on every flush, 5min throttle) + full (pruning, duplicate detection, orphan cleanup, file verification, 24h timer)
- **Single-file persistence** — `memory.json` (MemoryData v5 format with structured facts)
- **Periodic auto-flush** — writes every 30 seconds + on shutdown
- **Docker-ready** — single-stage Bun build, ~121MB image (oven/bun:1-alpine)

## Quick Start

### Local Development

```bash
bun install
bun --watch src/server.ts    # watch mode, auto-reload on changes
```

### Production

```bash
bun run src/server.ts        # Bun runs TypeScript natively — no build step needed
```

### Docker

```bash
docker build -t forkscout-memory-mcp .
docker run -d -p 3211:3211 -v memory-data:/data forkscout-memory-mcp

# or with docker compose
docker compose up -d
```

### Docker Hub

```bash
docker pull martianacademy/forkscout-memory-mcp:latest
docker run -d -p 3211:3211 -v memory-data:/data martianacademy/forkscout-memory-mcp
```

## Environment Variables

| Variable                   | Default                                 | Description                                               |
| -------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `MEMORY_PORT`              | `3211`                                  | HTTP server port                                          |
| `MEMORY_HOST`              | `0.0.0.0`                               | Bind address                                              |
| `MEMORY_STORAGE`           | `.forkscout` (local) / `/data` (Docker) | Directory for `memory.json`                               |
| `MEMORY_OWNER`             | `Admin`                                 | Owner name used in the self-entity                        |
| `CONSOLIDATION_INTERVAL_MS`| `86400000` (24h)                        | Full consolidation interval (pruning, dedup, verification)|
| `VERIFY_FILES`             | `true`                                  | Verify file entities against filesystem (disable in Docker)|

## Endpoints

| Method | Path      | Description                                                 |
| ------ | --------- | ----------------------------------------------------------- |
| `GET`  | `/health` | Health check — returns entity/relation/exchange/task counts + consolidation config |
| `GET`  | `/`       | Same as `/health`                                           |
| `POST` | `/mcp`    | MCP JSON-RPC endpoint (Streamable HTTP with SSE responses)  |

## MCP Tools (19)

### Knowledge

| Tool               | Description                                       |
| ------------------ | ------------------------------------------------- |
| `save_knowledge`   | Save a fact to long-term memory (with contradiction warnings) |
| `search_knowledge` | Search long-term memory by natural language query  |

### Entities

| Tool               | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `add_entity`       | Add or update an entity (returns contradiction warnings if detected) |
| `search_entities`  | Search entities by name or facts (bumps usage tracking)            |
| `get_entity`       | Look up a specific entity by name                                  |
| `get_all_entities` | Get all entities (optional limit)                                  |

### Relations

| Tool                | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `add_relation`      | Add a relation between two entities (auto-creates missing entities) |
| `get_all_relations` | Get all relations                                                   |

### Tasks

| Tool            | Description                                                 |
| --------------- | ----------------------------------------------------------- |
| `start_task`    | Start tracking a new task (or resume a similar running one) |
| `complete_task` | Mark a task as completed                                    |
| `abort_task`    | Abort a task with a reason                                  |
| `check_tasks`   | Show current active and paused tasks                        |

### Exchanges

| Tool               | Description                                       |
| ------------------ | ------------------------------------------------- |
| `add_exchange`     | Record a conversation exchange (user + assistant) |
| `search_exchanges` | Search conversation history                       |

### Self-Identity

| Tool              | Description                          |
| ----------------- | ------------------------------------ |
| `get_self_entity` | Get the agent's self-identity entity |
| `self_observe`    | Record a self-observation            |

### Maintenance

| Tool                  | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| `consolidate_memory`  | Run full consolidation (prune stale facts, detect duplicates)  |
| `get_stale_entities`  | Find entities not accessed for N days                          |
| `memory_stats`        | Show memory statistics and entity type breakdown               |

## Connecting from VS Code

Add to your VS Code settings or `.vscode/mcp.json`:

```json
{
    "mcp": {
        "servers": {
            "forkscout-memory": {
                "type": "http",
                "url": "http://localhost:3211/mcp"
            }
        }
    }
}
```

## Memory Intelligence

### Contradiction Detection

When adding facts to an entity, the server automatically detects contradictions:
- **Negation patterns** — "uses TypeScript" vs "does not use TypeScript"
- **Number/version conflicts** — "port is 3210" vs "port is 8080", "version 3.0" vs "version 5.0"

Contradictions are returned as warnings — both facts are kept, but the caller is alerted.

### Confidence System

Every fact has a confidence score based on:
- **Source base** (0.30–0.60) — how many independent sources confirmed the fact (permanent floor)
- **Recency bonus** (0–0.30) — additive bonus that decays over 90 days

Facts never decay below their source floor, even after years of inactivity. Protected entity types (`agent-self`, `person`, `project`, `preference`, `decision`, `organization`, `skill`, `constraint`) are never pruned.

### Usage Tracking

Every `search_entities` call bumps `accessCount` and `lastSeen` on retrieved entities, enabling stale entity detection.

### Two-Tier Consolidation

- **Light** — confidence refresh runs inside `flush()` on every dirty write (throttled to once per 5 minutes)
- **Full** — pruning, duplicate detection (Jaccard similarity), orphan relation cleanup, and file verification runs on a periodic timer (default 24h)

## Protocol

The server implements MCP over **Streamable HTTP** (stateless mode):

- Every `POST /mcp` receives a JSON-RPC 2.0 request
- Responses are SSE-wrapped: `event: message\ndata: {json-rpc response}\n\n`
- Notifications (no `id`) return HTTP `202 Accepted`
- Supported methods: `initialize`, `tools/list`, `tools/call`

## Data Format

`memory.json` uses **MemoryData v5** (structured facts with confidence):

```json
{
    "version": 5,
    "entities": [
        {
            "name": "...",
            "type": "person|project|technology|...",
            "facts": [
                { "content": "...", "sources": 1, "firstSeen": 0, "lastConfirmed": 0 }
            ],
            "lastSeen": 0,
            "accessCount": 0
        }
    ],
    "relations": [{ "from": "...", "to": "...", "type": "uses|owns|works-on|...", "weight": 1, "createdAt": 0 }],
    "exchanges": [{ "id": "ex_...", "user": "...", "assistant": "...", "timestamp": 0, "importance": 0.5, "sessionId": "..." }],
    "activeTasks": [
        {
            "id": "task_...",
            "title": "...",
            "goal": "...",
            "status": "running|paused|completed|aborted",
            "startedAt": 0,
            "lastStepAt": 0
        }
    ]
}
```

### Entity Types

`person` · `project` · `technology` · `preference` · `concept` · `file` · `service` · `organization` · `agent-self` · `decision` · `skill` · `constraint` · `other`

### Relation Types

`uses` · `owns` · `works-on` · `prefers` · `knows` · `depends-on` · `created` · `related-to` · `part-of` · `manages` · `dislikes` · `learned` · `improved`

## Project Structure

```
forkscout-memory-mcp/
├── src/
│   ├── server.ts    # HTTP server, MCP transport, consolidation timer, graceful shutdown
│   ├── store.ts     # MemoryStore — entities, relations, exchanges, search, consolidation, contradiction detection
│   ├── tasks.ts     # TaskManager — active task tracking & auto-expiry
│   ├── tools.ts     # 19 MCP tool registrations
│   └── types.ts     # Type definitions (MemoryData v5, Entity, Fact, Relation, etc.)
├── Dockerfile       # Single-stage: oven/bun:1-alpine — runs TypeScript natively
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── .dockerignore
```

## License

MIT
