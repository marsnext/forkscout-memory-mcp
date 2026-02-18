# forkscout-memory-mcp

Standalone MCP (Model Context Protocol) server for **Forkscout** shared memory — knowledge graph, conversation history, and active task tracking.

Lightweight, independent service. No agent, no LLM, no Playwright. Persists everything to a single `memory.json` file.

## Features

- **18 MCP tools** exposed over Streamable HTTP (stateless, one request = one response)
- **Knowledge graph** — entities, relations, facts, and full-text search
- **Conversation memory** — exchange tracking with search
- **Active task tracking** — start, complete, abort, heartbeat, auto-expire
- **Self-identity** — agent self-entity with observation recording
- **Single-file persistence** — `memory.json` (MemoryData v4 format)
- **Periodic auto-flush** — writes every 30 seconds + on shutdown
- **Docker-ready** — multi-stage build, ~161MB image (node:22-alpine)

## Quick Start

### Local Development

```bash
pnpm install
pnpm dev          # tsx watch mode, auto-reload on changes
```

### Production

```bash
pnpm build        # esbuild → dist/server.mjs (single bundled file)
pnpm start        # node dist/server.js
```

### Docker

```bash
docker build -t forkscout-memory-mcp .
docker run -d -p 3211:3211 -v memory-data:/data forkscout-memory-mcp
```

## Environment Variables

| Variable         | Default                                 | Description                        |
| ---------------- | --------------------------------------- | ---------------------------------- |
| `MEMORY_PORT`    | `3211`                                  | HTTP server port                   |
| `MEMORY_HOST`    | `0.0.0.0`                               | Bind address                       |
| `MEMORY_STORAGE` | `.forkscout` (local) / `/data` (Docker) | Directory for `memory.json`        |
| `MEMORY_OWNER`   | `Admin`                                 | Owner name used in the self-entity |

## Endpoints

| Method | Path      | Description                                                 |
| ------ | --------- | ----------------------------------------------------------- |
| `GET`  | `/health` | Health check — returns entity/relation/exchange/task counts |
| `GET`  | `/`       | Same as `/health`                                           |
| `POST` | `/mcp`    | MCP JSON-RPC endpoint (Streamable HTTP with SSE responses)  |

## MCP Tools (18)

### Knowledge

| Tool               | Description                                       |
| ------------------ | ------------------------------------------------- |
| `save_knowledge`   | Save a fact to long-term memory                   |
| `search_knowledge` | Search long-term memory by natural language query |

### Entities

| Tool               | Description                                    |
| ------------------ | ---------------------------------------------- |
| `add_entity`       | Add or update an entity in the knowledge graph |
| `search_entities`  | Search entities by name or facts               |
| `get_entity`       | Look up a specific entity by name              |
| `get_all_entities` | Get all entities (optional limit)              |

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

### System

| Tool           | Description                                      |
| -------------- | ------------------------------------------------ |
| `memory_stats` | Show memory statistics and entity type breakdown |
| `clear_all`    | Clear all memory (destructive, requires reason)  |

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

## Protocol

The server implements MCP over **Streamable HTTP** (stateless mode):

- Every `POST /mcp` receives a JSON-RPC 2.0 request
- Responses are SSE-wrapped: `event: message\ndata: {json-rpc response}\n\n`
- Notifications (no `id`) return HTTP `202 Accepted`
- Supported methods: `initialize`, `tools/list`, `tools/call`

## Data Format

`memory.json` uses **MemoryData v4**:

```json
{
    "version": 4,
    "entities": [
        { "name": "...", "type": "person|project|technology|...", "facts": [], "lastSeen": 0, "accessCount": 0 }
    ],
    "relations": [{ "from": "...", "to": "...", "type": "uses|owns|works-on|...", "createdAt": 0 }],
    "exchanges": [{ "id": "ex_...", "user": "...", "assistant": "...", "timestamp": 0, "sessionId": "..." }],
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

`person` · `project` · `technology` · `preference` · `concept` · `file` · `service` · `organization` · `agent-self` · `other`

### Relation Types

`uses` · `owns` · `works-on` · `prefers` · `knows` · `depends-on` · `created` · `related-to` · `part-of` · `manages` · `dislikes` · `learned` · `improved`

## Project Structure

```
forkscout-memory-mcp/
├── src/
│   ├── server.ts    # HTTP server, MCP transport, graceful shutdown
│   ├── store.ts     # MemoryStore — entities, relations, exchanges, search
│   ├── tasks.ts     # TaskManager — active task tracking & auto-expiry
│   ├── tools.ts     # 18 MCP tool registrations
│   └── types.ts     # Type definitions (MemoryData v4, Entity, Relation, etc.)
├── Dockerfile       # Multi-stage: esbuild bundle → node:22-alpine
├── package.json
├── tsconfig.json
└── .dockerignore
```

## License

Private — part of the Forkscout project.
