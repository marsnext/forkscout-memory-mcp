# forkscout-memory-mcp

**Persistent long-term memory for AI agents** — a standalone [MCP](https://modelcontextprotocol.io) server that gives LLMs something they fundamentally lack: the ability to remember, learn, and evolve across conversations.

Built for the [Forkscout](https://github.com/martianacademy/forkscout) autonomous agent. Works with any MCP-compatible client (VS Code Copilot, Claude Desktop, Cursor, custom agents).

---

## The Problem: LLMs Have No Memory

Every time you start a conversation with an LLM, it starts from zero. It doesn't know:

- What you told it yesterday
- What project you're working on
- What mistakes it made before and how it fixed them
- Who you are or what you prefer
- What decisions were already made and why

The standard "solutions" don't actually solve this:

| Approach                 | What it does                              | Why it fails                                                                                                                                                            |
| ------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System prompts**       | Static instructions pasted at the top     | Doesn't learn. Same instructions forever. Can't adapt.                                                                                                                  |
| **Conversation history** | Sends previous messages in context        | Limited by context window. Gone after session ends. Cross-project noise.                                                                                                |
| **RAG / Vector DB**      | Embeds documents, retrieves by similarity | Designed for _documents_, not _beliefs_. No confidence, no contradiction handling, no forgetting. Returns stale chunks alongside fresh ones with no way to distinguish. |
| **Fine-tuning**          | Trains weights on data                    | Expensive, slow, can't un-learn mistakes, not per-user.                                                                                                                 |
| **Chat memory plugins**  | Stores key-value pairs or summaries       | Flat structure, no relationships, no confidence, no scoping, no evolution tracking.                                                                                     |

The core issue: **none of these systems model knowledge the way intelligence actually works.** They store data. They don't maintain beliefs.

---

## What This Server Does Differently

forkscout-memory-mcp is a **belief maintenance system** disguised as an MCP server. It gives LLMs:

### 1. Structured Facts with Confidence (Not Just Strings)

Every fact has a confidence score, source count, and temporal metadata:

```
"TypeScript is the primary language" → confidence: 0.92, sources: 5, last confirmed: 2h ago
"Port is 3211"                      → confidence: 0.85, sources: 2, last confirmed: 3d ago
"Uses webpack for bundling"         → confidence: 0.31, sources: 1, last confirmed: 90d ago ← stale
```

Confidence is auto-calculated from evidence strength + recency. Facts confirmed by multiple sources rank higher. Old unconfirmed facts decay — but never below their evidence floor (a fact stated once still scores 0.30 even after a year).

**Why this matters:** When the LLM retrieves memory, it gets a ranked view of what it's most confident about — not a flat list of everything ever recorded.

### 2. Non-Destructive Belief Revision (Supersession, Not Deletion)

When new information contradicts old information, the old fact isn't deleted — it's **superseded**:

```
✓ Active:     "Project uses AI SDK v6"  (confidence: 0.95)
  ⤷ Superseded: "Project uses AI SDK v5" → replaced by "Project uses AI SDK v6" (2025-12-15)
    ⤷ Superseded: "Project uses AI SDK v4" → replaced by "Project uses AI SDK v5" (2025-09-01)
```

The full correction history is preserved. The LLM can inspect **how its beliefs evolved** — which past mistakes it made, what corrected them, and when.

**Why this matters:** RAG and vector DBs keep stale chunks forever alongside correct ones. The LLM has no way to know which version is current. Here, only active facts surface in search, but the learning history is always available on demand.

### 3. Automatic Contradiction Detection

Adding "port is 8080" when "port is 3211" already exists triggers a warning:

```
⚠️ CONTRADICTIONS DETECTED:
  • "port is 3211" vs "port is 8080" — Number/version conflict
```

Three detection strategies:

- **Negation patterns** — "uses X" vs "does not use X"
- **Number/version conflicts** — same context, different values
- **Topic overlap divergence** — high word overlap but different key terms (Jaccard similarity)

Contradicted facts are automatically superseded. The LLM is warned so it can reason about the conflict.

### 4. Multi-Dimensional Tagging for Cross-Project Isolation

The #1 problem with shared memory across projects: **search returns noise from unrelated projects.**

Every entity and exchange can be tagged:

```json
{
    "tags": {
        "project": "forkscout",
        "scope": "universal",
        "category": "debugging"
    }
}
```

Search uses **smart filtering**:

- Searching with `project: "forkscout"` returns:
    - ✅ Items tagged `project: "forkscout"` (project-specific)
    - ✅ Items tagged `scope: "universal"` (cross-project knowledge)
    - ✅ Items with no tags (backwards compatible, legacy data)
    - ❌ Items tagged `project: "other-project"` (filtered out)

**Why this matters:** An agent that works on forkscout on Monday and future-gain on Tuesday needs its TypeScript debugging patterns (universal) but not future-gain's database schema (project-specific). The tag filter does this automatically without requiring the LLM to manually filter results.

### 5. Knowledge Graph (Not Flat Storage)

Entities are connected by typed, weighted relationships:

```
forkscout-memory-mcp  ──uses──▶  TypeScript       (weight: 0.95, 5x confirmed)
forkscout-memory-mcp  ──uses──▶  Bun              (weight: 0.80, 3x confirmed)
forkscout-memory-mcp  ──part-of──▶  Forkscout     (weight: 0.90, 4x confirmed)
```

30+ entity types spanning cognition (`goal`, `task`, `plan`, `hypothesis`, `decision`), experience (`event`, `outcome`, `failure`, `success`), and environment (`resource`, `state`, `signal`).

40+ relation types including intentional (`pursues`, `plans`, `executes`, `blocks`), causal (`causes`, `results-in`, `leads-to`), and learning (`observed`, `predicted`, `confirmed`, `contradicted`).

Relations are reinforced by repeated evidence — the more times a connection is independently stated, the higher its weight.

### 6. Self-Identity and Learning

The agent maintains a self-entity where it records observations about its own behavior:

```
Forkscout Agent (agent-self):
  • [95%] Prefer spawn_agents for parallel research tasks
  • [88%] Always check memory before starting work
  • [72%] When debugging, reproduce the error first before reading code
```

These self-observations accumulate across sessions. The agent literally learns how to be a better agent — what debugging strategies work, what communication patterns the user prefers, what mistakes to avoid.

### 7. Active Task Tracking (Executive Memory)

Tasks survive server restarts:

```
⚡ Running: "Implement multi-dimensional tagging" (task_abc123) — 45min, P80
✓ Completed: "Fix planner duplicate processing" — 12min
✗ Aborted: "Migrate to Rust" — Deprioritized
```

Auto-expiry after 2 hours prevents zombie tasks. Similar task detection prevents duplicates.

---

## Architecture Comparison

```
┌─────────────────────────────────────────────────────────┐
│                   Traditional RAG                        │
│                                                         │
│  Documents → Chunker → Embeddings → Vector DB → Search  │
│                                                         │
│  ✗ No confidence       ✗ No contradiction handling      │
│  ✗ No belief evolution  ✗ No project scoping            │
│  ✗ Stale = Fresh        ✗ No relationships              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              forkscout-memory-mcp                        │
│                                                         │
│  Facts → Confidence + Sources → Contradiction Check →   │
│  Knowledge Graph (entities + relations) →               │
│  Tag-filtered Search (project-scoped + universal) →     │
│  Ranked results (confidence × recency × access) →       │
│  Supersession chains (belief evolution history)         │
│                                                         │
│  ✓ Confidence scoring   ✓ Automatic contradiction       │
│  ✓ Non-destructive      ✓ Multi-project isolation       │
│  ✓ Self-identity        ✓ Task tracking                 │
│  ✓ Relationship graph   ✓ Two-tier consolidation        │
└─────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Local Development

```bash
bun install
bun --watch src/server.ts    # watch mode, auto-reload on changes
```

### Production

```bash
bun run src/server.ts        # Bun runs TypeScript natively — no build step
```

### Docker

```bash
docker build -t forkscout-memory-mcp .
docker run -d -p 3211:3211 -v memory-data:/data forkscout-memory-mcp

# or with docker compose
docker compose up -d
```

### Docker Hub / GHCR

```bash
docker pull ghcr.io/martianacademy/forkscout-memory-mcp:latest
docker run -d -p 3211:3211 -v memory-data:/data ghcr.io/martianacademy/forkscout-memory-mcp
```

### Connect from VS Code

Add to `.vscode/mcp.json`:

```json
{
    "servers": {
        "forkscout-memory": {
            "type": "http",
            "url": "http://localhost:3211/mcp"
        }
    }
}
```

---

## Environment Variables

| Variable                    | Default                                 | Description                              |
| --------------------------- | --------------------------------------- | ---------------------------------------- |
| `MEMORY_PORT`               | `3211`                                  | HTTP server port                         |
| `MEMORY_HOST`               | `0.0.0.0`                               | Bind address                             |
| `MEMORY_STORAGE`            | `.forkscout` (local) / `/data` (Docker) | Directory for `memory.json`              |
| `MEMORY_OWNER`              | `Admin`                                 | Owner name used in the self-entity       |
| `SELF_ENTITY_NAME`          | `Forkscout Agent`                       | Name of the agent's self-identity entity |
| `CONSOLIDATION_INTERVAL_MS` | `86400000` (24h)                        | Full consolidation interval              |
| `VERIFY_FILES`              | `true`                                  | Verify file entities against filesystem  |

## Endpoints

| Method | Path      | Description                                                |
| ------ | --------- | ---------------------------------------------------------- |
| `GET`  | `/health` | Health check — entity/relation/exchange/task counts        |
| `GET`  | `/`       | Same as `/health`                                          |
| `POST` | `/mcp`    | MCP JSON-RPC endpoint (Streamable HTTP with SSE responses) |

---

## MCP Tools (22)

### Knowledge

| Tool               | Params                                    | Description                                        |
| ------------------ | ----------------------------------------- | -------------------------------------------------- |
| `save_knowledge`   | `fact`, `category?`, `project?`, `scope?` | Save a fact with optional project tag and scope    |
| `search_knowledge` | `query`, `limit?`, `project?`             | Search memory — project-scoped + universal results |

### Entities

| Tool               | Params                           | Description                                                 |
| ------------------ | -------------------------------- | ----------------------------------------------------------- |
| `add_entity`       | `name`, `type`, `facts`, `tags?` | Add/update entity with tags. Returns contradiction warnings |
| `update_entity`    | `name`, `oldFact`, `newFact`     | Replace a fact (old one superseded, retained as history)    |
| `remove_fact`      | `name`, `factSubstring`          | Supersede facts by substring match                          |
| `search_entities`  | `query`, `limit?`, `project?`    | Search entities by name/facts with project filtering        |
| `get_entity`       | `name`, `includeHistory?`        | Look up entity, optionally with supersession history        |
| `get_all_entities` | `limit?`                         | List all entities                                           |

### Relations

| Tool                | Params               | Description                                           |
| ------------------- | -------------------- | ----------------------------------------------------- |
| `add_relation`      | `from`, `to`, `type` | Add weighted relation (auto-creates missing entities) |
| `get_all_relations` | —                    | List all relations                                    |

### Tasks

| Tool            | Params                                                           | Description                                     |
| --------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| `start_task`    | `title`, `goal`, `successCondition?`, `priority?`, `importance?` | Start tracking (or resume similar running task) |
| `complete_task` | `taskId`, `result?`                                              | Mark task completed                             |
| `abort_task`    | `taskId`, `reason`                                               | Abort with reason                               |
| `check_tasks`   | —                                                                | List active tasks with status and duration      |

### Exchanges

| Tool               | Params                                                      | Description                                   |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------- |
| `add_exchange`     | `user`, `assistant`, `sessionId`, `importance?`, `project?` | Record conversation with project tag          |
| `search_exchanges` | `query`, `limit?`, `project?`                               | Search past conversations with project filter |

### Self-Identity

| Tool              | Params    | Description                                  |
| ----------------- | --------- | -------------------------------------------- |
| `get_self_entity` | —         | Get agent's identity + all learned behaviors |
| `self_observe`    | `content` | Record a self-observation                    |

### Memory Intelligence

| Tool                 | Params                                            | Description                                          |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `get_fact_history`   | `name`                                            | See belief evolution — supersession chains over time |
| `consolidate_memory` | `minConfidence?`, `maxStaleDays?`, `archiveDays?` | Run full consolidation cycle                         |
| `get_stale_entities` | `maxAgeDays?`, `types?`, `limit?`                 | Find entities not accessed recently                  |
| `memory_stats`       | —                                                 | Entity/relation/exchange counts + type breakdown     |

---

## How Confidence Works

Every fact's confidence is auto-calculated:

```
confidence = sourceBase + recencyBonus

sourceBase (permanent floor):
  1 source  → 0.30
  2 sources → 0.42
  3 sources → 0.50
  5+ sources → 0.60

recencyBonus (decays over 90 days):
  just confirmed → +0.30
  30 days ago    → +0.21
  90 days ago    → +0.11
  180 days ago   → +0.04
```

**Key design decision:** Long-term knowledge never decays to zero. A fact stated once still scores 0.30 after years. Only the recency bonus decays — the evidence floor is permanent. This prevents the common RAG problem where valid but old information gets garbage-collected.

Protected entity types are never pruned regardless of confidence: `agent-self`, `person`, `project`, `preference`, `decision`, `organization`, `skill`, `constraint`.

---

## Two-Tier Consolidation

### Light (every flush, 5min throttle)

- Confidence score refresh on all active facts

### Full (every 24h + on-demand)

1. Confidence refresh across all entities
2. Archive superseded facts older than 180 days
3. Prune stale low-confidence active facts on non-protected entities (>60 days, <0.30 confidence)
4. Remove empty entities (no active facts)
5. Clean orphan relations (referencing deleted entities)
6. Detect near-duplicate entities (Jaccard similarity >0.70 on same type)
7. Verify file entities against filesystem (optional)

---

## Data Format

`memory.json` — **MemoryData v7** (structured facts with confidence, versioning, and multi-dimensional tags):

```json
{
    "version": 7,
    "entities": [
        {
            "name": "forkscout-memory-mcp",
            "type": "service",
            "facts": [
                {
                    "content": "TypeScript MCP server with JSON persistence",
                    "confidence": 0.92,
                    "sources": 3,
                    "firstSeen": 1708000000000,
                    "lastConfirmed": 1708600000000,
                    "status": "active"
                },
                {
                    "content": "Uses MemoryData v5 schema",
                    "confidence": 0.65,
                    "sources": 1,
                    "firstSeen": 1707000000000,
                    "lastConfirmed": 1707000000000,
                    "status": "superseded",
                    "supersededBy": "Schema v7 with multi-dimensional tags",
                    "supersededAt": 1708600000000
                }
            ],
            "lastSeen": 1708600000000,
            "accessCount": 42,
            "tags": { "project": "forkscout", "scope": "project" }
        }
    ],
    "relations": [
        {
            "from": "forkscout-memory-mcp",
            "to": "TypeScript",
            "type": "uses",
            "weight": 0.95,
            "evidenceCount": 5,
            "lastValidated": 1708600000000,
            "createdAt": 1707000000000
        }
    ],
    "exchanges": [
        {
            "id": "ex_1708600000000_a1b2",
            "user": "How does contradiction detection work?",
            "assistant": "Three strategies: negation patterns, number/version conflicts, and topic overlap divergence...",
            "timestamp": 1708600000000,
            "sessionId": "session_abc",
            "importance": 0.8,
            "tags": { "project": "forkscout" }
        }
    ],
    "activeTasks": [
        {
            "id": "task_1708600000000_x1y2",
            "title": "Implement tagging system",
            "goal": "Add multi-dimensional tags to entities and exchanges",
            "status": "completed",
            "startedAt": 1708600000000,
            "lastStepAt": 1708603600000,
            "priority": 0.8,
            "importance": 0.9
        }
    ]
}
```

### Schema Migration

The server auto-migrates on startup:

- **v4** → v7: Plain string facts → structured facts with confidence, versioning, and tags
- **v5** → v7: Add fact status (`active`/`superseded`), clean `[SUPERSEDED]` text prefixes, add tags
- **v6** → v7: Add `tags` field to entities and exchanges

Migration is non-destructive. All data is preserved.

### Entity Types (30)

**Core:** `person` · `project` · `technology` · `preference` · `concept` · `file` · `service` · `organization` · `agent-self` · `other`

**Cognition:** `goal` · `task` · `plan` · `skill` · `problem` · `hypothesis` · `decision` · `constraint`

**Experience:** `event` · `episode` · `outcome` · `failure` · `success`

**Environment:** `resource` · `state` · `signal`

### Relation Types (40+)

**Structural:** `uses` · `owns` · `works-on` · `prefers` · `knows` · `depends-on` · `created` · `related-to` · `part-of` · `manages` · `dislikes` · `learned` · `improved`

**Intentional:** `pursues` · `plans` · `executes` · `blocks` · `requires` · `prioritizes`

**Temporal/Causal:** `causes` · `results-in` · `leads-to` · `precedes` · `follows`

**Learning:** `observed` · `predicted` · `confirmed` · `contradicted` · `generalizes` · `derived-from`

**Performance:** `succeeded-at` · `failed-at` · `improved-by` · `degraded-by`

**Memory:** `remembers` · `forgets` · `updates` · `replaces`

---

## Protocol

MCP over **Streamable HTTP** (stateless mode):

- `POST /mcp` — JSON-RPC 2.0 request
- Response: SSE-wrapped (`event: message\ndata: {json}\n\n`)
- Notifications (no `id`): HTTP `202 Accepted`
- Methods: `initialize`, `tools/list`, `tools/call`

No persistent connections. No WebSocket. One request = one response. This makes it trivially deployable behind any reverse proxy or load balancer.

---

## Project Structure

```
forkscout-memory-mcp/
├── src/
│   ├── server.ts    # HTTP server, MCP transport, consolidation timer, graceful shutdown
│   ├── store.ts     # MemoryStore — CRUD, search, contradiction detection, consolidation, tag filtering
│   ├── tasks.ts     # TaskManager — active task tracking, auto-expiry, similarity detection
│   ├── tools.ts     # 22 MCP tool registrations with Zod schemas
│   └── types.ts     # Type definitions (MemoryData v7, Entity, Fact, Relation, Exchange, etc.)
├── Dockerfile       # Single-stage: oven/bun:1-alpine — runs TypeScript natively
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── .dockerignore
```

---

## Why Not Just Use a Vector Database?

Vector databases (Pinecone, Chroma, Weaviate) are excellent for document retrieval. They are the wrong tool for agent memory.

| Feature                 | Vector DB                      | forkscout-memory-mcp                           |
| ----------------------- | ------------------------------ | ---------------------------------------------- |
| Storage unit            | Document chunks                | Structured facts with metadata                 |
| Confidence              | None — all results are equal   | 0–1 score per fact, auto-calculated            |
| Contradiction handling  | None — old and new coexist     | Automatic detection + supersession             |
| Belief evolution        | Not possible                   | Full history with supersession chains          |
| Cross-project isolation | Namespace-only                 | Smart scoping (project + universal + untagged) |
| Relationship modeling   | None                           | Weighted, typed knowledge graph                |
| Self-identity           | Not applicable                 | Built-in agent self-entity                     |
| Forgetting              | Manual deletion                | Confidence decay + consolidation               |
| Setup                   | Managed service or heavy infra | Single JSON file, zero dependencies            |
| Cost                    | Per-query pricing or hosting   | Free, runs locally                             |

The right mental model: **a vector DB is a library** (stores documents for lookup). **forkscout-memory-mcp is a brain** (maintains beliefs, learns from corrections, tracks what it's confident about).

---

## License

MIT
