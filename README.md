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

### 4. Hybrid Semantic + BM25 Search

Recall uses **two search layers running in parallel**:

- **BM25 (lexical)** — exact keyword matching, term frequency, fast
- **Semantic (vector)** — meaning-based matching via `Xenova/all-MiniLM-L6-v2` (384-dim, quantized ONNX, runs locally, no API key needed)

Results are merged with a tunable alpha weight (default: 60% semantic, 40% BM25). This means:

- Searching "database port" also finds "3211 listen address" (semantic)
- Searching "libsimdjson" finds exact matches even with no semantic neighbors (BM25)
- Both signals reinforce each other for common queries

Embeddings are computed on-demand and cached in `memory-embeddings.json`. The Xenova model auto-downloads on first startup (~23MB) and is saved to `TRANSFORMERS_CACHE` (default: `/data/.cache` in Docker).

### 5. Multi-Dimensional Tagging for Cross-Project Isolation

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

### 6. Knowledge Graph with 120+ Relation Types (Not Flat Storage)

Entities are connected by typed, weighted relationships:

```
forkscout-memory-mcp  ──uses──▶  TypeScript       (weight: 0.95, 5x confirmed)
forkscout-memory-mcp  ──uses──▶  Bun              (weight: 0.80, 3x confirmed)
forkscout-memory-mcp  ──part-of──▶  Forkscout     (weight: 0.90, 4x confirmed)
```

30 entity types spanning cognition (`goal`, `task`, `plan`, `hypothesis`, `decision`), experience (`event`, `outcome`, `failure`, `success`), and environment (`resource`, `state`, `signal`).

120+ relation types organized across 15 categories including structural, intentional, causal, temporal, and learning dimensions. Relations are reinforced by repeated evidence — the more times a connection is independently stated, the higher its weight.

### 7. Self-Identity and Learning

The agent maintains a self-entity where it records observations about its own behavior:

```
Forkscout Agent (agent-self):
  • [95%] Prefer spawn_agents for parallel research tasks
  • [88%] Always check memory before starting work
  • [72%] When debugging, reproduce the error first before reading code
```

These self-observations accumulate across sessions. The agent literally learns how to be a better agent — what debugging strategies work, what communication patterns the user prefers, what mistakes to avoid.

### 8. Exchange Memory with Auto-Importance + Deduplication

Conversation exchanges are stored and searchable:

```
observe("How do I fix port conflict?", "Check if port 3211 is in use with lsof -i :3211...")
→ importance auto-calculated from message length + keyword density
→ deduplication: similar exchanges (>0.85 similarity) are merged, not duplicated
→ hot tier: last 500 exchanges in full
→ archive tier: older exchanges indexed by embedding only
```

Exchanges can be tagged by project for scoped recall. On search, both lexical and semantic matching run against the exchange history.

### 9. Working Memory Persistence (Session Context)

In-session working memory (recent actions, decisions, errors) is persisted across server restarts:

```json
"workingMemorySessions": {
  "session_abc": [
    { "content": "Started migrating schema to v7", "event_type": "action", "timestamp": 1708600000000 },
    { "content": "Found contradiction in port facts", "event_type": "observation" }
  ]
}
```

The last 25 events per session are kept. On restart, the agent can recall exactly where it left off mid-task.

### 10. Active Task Tracking (Executive Memory)

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
│  Tag-filtered Hybrid Search (BM25 + Semantic) →         │
│  Ranked results (confidence × recency × access) →       │
│  Supersession chains (belief evolution history)         │
│                                                         │
│  ✓ Confidence scoring   ✓ Automatic contradiction       │
│  ✓ Non-destructive      ✓ Multi-project isolation       │
│  ✓ Self-identity        ✓ Task tracking                 │
│  ✓ Relationship graph   ✓ Two-tier consolidation        │
│  ✓ Hybrid search        ✓ Working memory persistence    │
│  ✓ Exchange memory      ✓ Interactive visualizer        │
└─────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Local Development

```bash
bun install
bun --watch src/server.ts    # watch mode, auto-reload on changes
```

> **Note:** Bun is required. The Xenova/all-MiniLM-L6-v2 model (~23MB) auto-downloads on first start into `TRANSFORMERS_CACHE`. Subsequent starts are instant.

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

| Variable                    | Default                                 | Description                                              |
| --------------------------- | --------------------------------------- | -------------------------------------------------------- |
| `MEMORY_PORT`               | `3211`                                  | HTTP server port                                         |
| `MEMORY_HOST`               | `0.0.0.0`                               | Bind address                                             |
| `MEMORY_STORAGE`            | `.forkscout` (local) / `/data` (Docker) | Directory for `memory.json` and `memory-embeddings.json` |
| `MEMORY_OWNER`              | `Admin`                                 | Owner name used in the self-entity                       |
| `SELF_ENTITY_NAME`          | `Forkscout Agent`                       | Name of the agent's self-identity entity                 |
| `CONSOLIDATION_INTERVAL_MS` | `86400000` (24h)                        | Full consolidation interval                              |
| `VERIFY_FILES`              | `true`                                  | Verify file entities against filesystem                  |
| `TRANSFORMERS_CACHE`        | `/data/.cache` (Docker)                 | Where Xenova model weights are cached                    |
| `CORS_ORIGIN`               | `*`                                     | CORS allowed origin(s)                                   |

---

## Endpoints

| Method | Path          | Description                                                |
| ------ | ------------- | ---------------------------------------------------------- |
| `GET`  | `/health`     | Health check — entity/relation/exchange/task counts        |
| `GET`  | `/`           | Same as `/health`                                          |
| `GET`  | `/api/memory` | Raw memory JSON (full MemoryData dump — use for debugging) |
| `GET`  | `/visualizer` | Interactive knowledge graph visualizer (infinite canvas)   |
| `POST` | `/mcp`        | MCP JSON-RPC endpoint (Streamable HTTP with SSE responses) |

---

## MCP Tools (9)

### `remember` — Store or Update Entity Facts

Store facts on a named entity. New facts are merged. Contradictions trigger warnings and auto-supersede the old fact.

| Param       | Type     | Required | Description                                                         |
| ----------- | -------- | -------- | ------------------------------------------------------------------- |
| `name`      | string   | ✓        | Entity name (exact match merges, new name creates)                  |
| `type`      | enum     | ✓        | Entity type — see Entity Types below                                |
| `facts`     | string[] | ✓        | Facts to add / merge. Pass `[]` + `supersede` to remove a fact      |
| `supersede` | string   | —        | Substring of the fact to replace with `facts[0]`                    |
| `tags`      | object   | —        | Scoped tags e.g. `{ "project": "forkscout", "scope": "universal" }` |

```json
{
  "name": "forkscout-memory-mcp",
  "type": "service",
  "facts": ["HTTP port is 3211", "runs on Bun 1.3.9"],
  "tags": { "project": "forkscout" }
}
```

---

### `recall` — Multi-Modal Memory Retrieval

Five retrieval modes covering all memory layers.

| Param             | Type   | Required | Description                                                           |
| ----------------- | ------ | -------- | --------------------------------------------------------------------- |
| `mode`            | enum   | —        | `search` (default) · `entity` · `history` · `relations` · `exchanges` |
| `query`           | string | \*       | Search text (required for `search` and `exchanges` modes)             |
| `name`            | string | \*       | Entity name (required for `entity` and `history` modes)               |
| `limit`           | number | —        | Max results (default: 5)                                              |
| `project`         | string | —        | Project tag for scoped filtering                                      |
| `include_history` | bool   | —        | Include superseded facts in `entity` mode (default: false)            |

**Modes:**

- `search` — BM25 + semantic hybrid search across entities + exchanges
- `entity` — get one entity by exact name; `include_history: true` shows supersession chain
- `history` — belief evolution: what was corrected and when (requires `name`)
- `relations` — all knowledge graph edges; optional `name` restricts to one entity
- `exchanges` — search conversation history by keyword

---

### `observe` — Record a Conversation Exchange

Record a significant conversation into long-term memory AND push to working memory.

| Param        | Type   | Required | Description                                   |
| ------------ | ------ | -------- | --------------------------------------------- |
| `user`       | string | ✓        | User message                                  |
| `assistant`  | string | ✓        | Assistant response                            |
| `sessionId`  | string | ✓        | Session identifier                            |
| `importance` | number | —        | Significance 0–1 (auto-calculated if omitted) |
| `project`    | string | —        | Project tag for scoped recall                 |

Importance is auto-calculated from message length and keyword density if omitted. Deduplication runs at 0.85 similarity threshold — duplicates are merged, not appended.

Only record exchanges with non-trivial decisions, root causes, or earned insights. Skip routine tool output.

---

### `relate` — Create or Reinforce a Relation

Create a typed edge between two entities.

| Param  | Type   | Required | Description                              |
| ------ | ------ | -------- | ---------------------------------------- |
| `from` | string | ✓        | Source entity name                       |
| `to`   | string | ✓        | Target entity name                       |
| `type` | enum   | ✓        | Relation type — see Relation Types below |

Duplicate edges auto-merge and gain confidence weight. Missing entities are auto-created as type `other`.

> **Rule:** Run `recall(mode="search")` on both names first to confirm they exist and avoid creating duplicate entities.

---

### `context` — Working Memory (Session-Scoped)

In-RAM, session-scoped working memory. Track what you are doing right now: actions taken, decisions made, errors hit.

| Param        | Type   | Required | Description                                                     |
| ------------ | ------ | -------- | --------------------------------------------------------------- |
| `action`     | enum   | ✓        | `push` · `get` · `clear`                                        |
| `session_id` | string | ✓        | Session identifier                                              |
| `content`    | string | \*       | [push] What happened / decided / failed                         |
| `event_type` | enum   | —        | [push] `action` · `observation` · `decision` · `error` · `fact` |
| `limit`      | number | —        | [get] Recent events to return (default: 10)                     |

Keeps the last 25 events per session. Call at session start with `action: "get"` to recall where you left off. Working memory is persisted to `memory.json` across server restarts.

---

### `task` — Executive Memory for Multi-Step Work

Tasks survive server restarts and provide chronological tracking.

| Param              | Type   | Required | Description                               |
| ------------------ | ------ | -------- | ----------------------------------------- |
| `action`           | enum   | ✓        | `start` · `done` · `abort` · `list`       |
| `title`            | string | \*       | [start] Short label (3–7 words)           |
| `goal`             | string | \*       | [start] What you are trying to accomplish |
| `successCondition` | string | —        | [start] How to know when done             |
| `priority`         | number | —        | [start] Priority 0–1                      |
| `importance`       | number | —        | [start] Long-term importance 0–1          |
| `taskId`           | string | \*       | [done/abort] Task ID returned by `start`  |
| `result`           | string | —        | [done] Outcome summary                    |
| `reason`           | string | \*       | [abort] Why the task was stopped          |

- `start`: detects similar existing tasks to avoid duplicates. Returns `taskId`.
- `done`: marks complete + auto-saves a success record for future recall.
- `abort`: stops + saves a failure post-mortem for future learning.
- `list`: shows all active and paused tasks with elapsed durations.

Auto-expiry after 2 hours prevents zombie tasks.

---

### `introspect` — Memory Self-Inspection

Get statistics and identify stale or volatile facts. Run at session startup.

| Param   | Type   | Required | Description                                           |
| ------- | ------ | -------- | ----------------------------------------------------- |
| `view`  | enum   | —        | `stats` · `stale` · `gaps` · `all` (default: `stats`) |
| `limit` | number | —        | Max results for stale/gaps (default: 20)              |
| `types` | array  | —        | [stale] Filter by entity type                         |

**Views:**

- `stats` — entity/relation/exchange counts and type breakdown
- `stale` — entities not accessed recently (candidates for verification or pruning)
- `gaps` — volatile facts (versions, ports, paths, env vars) that may be outdated
- `all` — combined report — **recommended at session startup**

---

### `consolidate` — Memory Maintenance

Refresh confidence scores, prune stale facts, remove empty entities, clean orphan relations, archive old data, detect near-duplicates.

| Param           | Type   | Required | Description                                                   |
| --------------- | ------ | -------- | ------------------------------------------------------------- |
| `archiveDays`   | number | —        | Min age before superseded facts are archived (default: 180)   |
| `maxStaleDays`  | number | —        | Max age for low-confidence facts before pruning (default: 60) |
| `minConfidence` | number | —        | Min confidence to keep active fact (default: 0.15)            |

Run periodically or when memory grows large. Superseded (historical) facts are only archived after `archiveDays` to preserve learning history.

---

### `forget` — Remove a Fact

Supersede a fact from an entity by substring match.

| Param           | Type   | Required | Description                        |
| --------------- | ------ | -------- | ---------------------------------- |
| `name`          | string | ✓        | Entity name                        |
| `factSubstring` | string | ✓        | Substring of the fact to supersede |

The fact is superseded (not hard-deleted) — history is preserved. Use `recall(mode="entity", include_history: true)` to see superseded facts.

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

## How Hybrid Search Works

Every search call runs two engines in parallel, then merges results:

```
Query: "database port configuration"
         │
    ┌────┴─────────────┐
    │                  │
  BM25              Semantic
  (keyword)         (vector)
    │                  │
  Finds:             Finds:
  "database"    "listen address 3211"
  "port"        "server bind config"
  "configuration"  "networking setup"
    │                  │
    └────┬─────────────┘
         │
    Merge (alpha=0.6)
    → 60% semantic score + 40% BM25 score
         │
    Rerank by confidence × recency
         │
    Top-K results
```

| BM25 alone                      | Semantic alone                          |
| ------------------------------- | --------------------------------------- |
| Misses synonyms and paraphrases | Misses exact version strings            |
| "3211 port" ≠ "listen address"  | "libsimdjson" has no semantic neighbors |
| Fast, no model needed           | Requires embedding computation          |

Together they cover both ends: exact technical strings AND conceptual meaning.

Embeddings are computed lazily on first access and cached in `memory-embeddings.json`. Cache is invalidated when entities change.

---

## Two-Tier Consolidation

### Light (every flush, 5min throttle)

- Confidence score refresh on all active facts

### Full (every 24h + on-demand via `consolidate` tool)

1. Confidence refresh across all entities
2. Archive superseded facts older than 180 days
3. Prune stale low-confidence active facts on non-protected entities (>60 days, <0.30 confidence)
4. Remove empty entities (no active facts)
5. Clean orphan relations (referencing deleted entities)
6. Detect near-duplicate entities (Jaccard similarity >0.70 on same type)
7. Archive old exchanges from hot tier (500 cap) to archive tier
8. Verify file entities against filesystem (optional)

---

## Built-in Visualizer

Open `http://localhost:3211/visualizer` in a browser to explore the knowledge graph interactively.

### Features

- **Infinite canvas** — pan freely in any direction, no bounds. Dot-grid SVG background extends infinitely.
- **Zoom-proof scaling** — nodes, labels, and edges maintain minimum on-screen size at any zoom level:
  ```
  nodeRadius = max(base / zoom^1.25, 9px / zoom)   → always ≥9px on screen
  fontSize   = max(base / zoom^1.15, 10px / zoom)  → always ≥10px on screen
  edgeWidth  = max(base / zoom^0.95, 0.8px / zoom) → always visible
  ```
- **Radial layout by degree** — entities with the most relations are placed at the outer ring; isolated nodes cluster near center:
  ```
  pct = 1 - rank / (N-1)   // rank 0 (most connected) → pct=1 → outermost
  r   = maxRadius × (0.12 + pct × 0.88)
  ```
- **Node dragging** — drag any node to a custom position, saved to localStorage (key: `v4`) and restored on next visit.
- **Fullscreen mode** — expand to full viewport, borderless infinite canvas.
- **Smart limits** — displays up to 300 nodes and 600 edges without performance degradation.

### Controls

| Interaction          | Action                                  |
| -------------------- | --------------------------------------- |
| Scroll               | Zoom in / out                           |
| Drag canvas (empty)  | Pan infinitely in any direction         |
| Drag node            | Reposition node (saved to localStorage) |
| Double-click canvas  | Fit all nodes to view                   |
| Double-click node    | Highlight node + its direct relations   |
| Click entity in list | Zoom to and highlight that node         |
| Expand button (↗)    | Fullscreen infinite canvas mode         |

### Node Color Legend

| Color       | Entity category              |
| ----------- | ---------------------------- |
| Blue        | Service / Technology         |
| Green       | Person / Organization        |
| Purple      | Project / Goal / Plan        |
| Orange      | Task / Decision / Constraint |
| Red         | Failure / Problem            |
| Teal        | Concept / Skill / Preference |
| Gray        | File / Other                 |
| Gold border | Agent-self entity            |

---

## Data Format

`memory.json` — **MemoryData v7** (structured facts with confidence, versioning, multi-dimensional tags, and working memory sessions):

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
  ],
  "workingMemorySessions": {
    "session_abc": [
      {
        "content": "Started migrating schema to v7",
        "event_type": "action",
        "timestamp": 1708600000000
      },
      {
        "content": "Found contradiction in port facts — resolved to 3211",
        "event_type": "observation",
        "timestamp": 1708600100000
      }
    ]
  }
}
```

### Schema Migration

The server auto-migrates on startup:

- **v4** → v7: Plain string facts → structured facts with confidence, versioning, and tags
- **v5** → v7: Add fact status (`active`/`superseded`), clean `[SUPERSEDED]` text prefixes, add tags
- **v6** → v7: Add `tags` to entities and exchanges, add `workingMemorySessions`

Migration is non-destructive. All data is preserved.

### Entity Types (30)

**Core:** `person` · `project` · `technology` · `preference` · `concept` · `file` · `service` · `organization` · `agent-self` · `other`

**Cognition:** `goal` · `task` · `plan` · `skill` · `problem` · `hypothesis` · `decision` · `constraint`

**Experience:** `event` · `episode` · `outcome` · `failure` · `success`

**Environment:** `resource` · `state` · `signal`

### Relation Types (120+)

**Structural:**
`uses` · `owns` · `works-on` · `prefers` · `knows` · `depends-on` · `created` · `related-to` · `part-of` · `manages` · `dislikes` · `learned` · `improved`

**Intentional:**
`pursues` · `plans` · `executes` · `blocks` · `requires` · `prioritizes`

**Temporal/Causal:**
`causes` · `results-in` · `leads-to` · `precedes` · `follows`

**Learning:**
`observed` · `predicted` · `confirmed` · `contradicted` · `generalizes` · `derived-from`

**Performance:**
`succeeded-at` · `failed-at` · `improved-by` · `degraded-by`

**Memory:**
`remembers` · `forgets` · `updates` · `replaces`

**Communication:**
`discusses` · `mentions` · `references` · `quotes` · `summarizes` · `clarifies` · `asks-about` · `answers`

**Social:**
`collaborates-with` · `reports-to` · `reviews` · `approves` · `delegates-to` · `advises` · `teaches` · `learns-from`

**Technical:**
`implements` · `extends` · `overrides` · `calls` · `imports` · `exports` · `configures` · `deploys` · `monitors` · `tests` · `documents` · `generates` · `parses` · `validates` · `transforms`

**State/Lifecycle:**
`initializes` · `activates` · `deactivates` · `pauses` · `resumes` · `completes` · `fails` · `retries` · `cancels` · `schedules`

**Spatial/Organizational:**
`contains` · `located-in` · `belongs-to` · `groups` · `categorizes` · `indexes` · `archives`

**Comparative:**
`similar-to` · `different-from` · `better-than` · `worse-than` · `equivalent-to` · `alternative-to` · `complement-to`

**Causal-Extended:**
`enables` · `prevents` · `triggers` · `mitigates` · `amplifies` · `constrains` · `supports` · `contradicts-with`

**Epistemic:**
`believes` · `doubts` · `assumes` · `hypothesizes` · `verifies` · `refutes` · `questions` · `trusts`

**Goal/Motivation:**
`motivates` · `discourages` · `aligns-with` · `conflicts-with` · `depends-on-goal`

---

## Protocol

MCP over **Streamable HTTP** (stateless mode):

- `POST /mcp` — JSON-RPC 2.0 request
- Response: SSE-wrapped (`event: message\ndata: {json}\n\n`)
- Notifications (no `id`): HTTP `202 Accepted`
- Methods: `initialize`, `tools/list`, `tools/call`

No persistent connections. No WebSocket. One request = one response. Trivially deployable behind any reverse proxy or load balancer.

---

## Project Structure

```
forkscout-memory-mcp/
├── src/
│   ├── server.ts         # HTTP server, MCP transport, consolidation timer, graceful shutdown
│   ├── store.ts          # MemoryStore — CRUD, search, contradiction detection, consolidation, tag filtering
│   ├── tasks.ts          # TaskManager — active task tracking, auto-expiry, similarity detection
│   ├── tools.ts          # 9 MCP tool registrations with Zod schemas
│   ├── types.ts          # Type definitions (MemoryData v7, Entity, Fact, Relation, Exchange, etc.)
│   ├── embeddings.ts     # Xenova/all-MiniLM-L6-v2 embedding + BM25 hybrid search engine
│   ├── working-memory.ts # Session-scoped working memory (push/get/clear, last 25 events)
│   └── visualizer.ts     # Infinite canvas knowledge graph visualizer (SVG, radial layout)
├── Dockerfile            # Single-stage: oven/bun:1 (Debian) — runs TypeScript natively, no build step
├── docker-compose.yml    # Volume: memory-data → /data, network: forkscout_default
├── package.json
├── tsconfig.json
└── .dockerignore
```

> **Docker base image:** Uses `oven/bun:1` (Debian), not Alpine. Alpine was dropped due to musl libc incompatibilities with the Xenova ONNX runtime.

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
| Relationship modeling   | None                           | Weighted, typed knowledge graph (120+ types)   |
| Self-identity           | Not applicable                 | Built-in agent self-entity                     |
| Working memory          | Not applicable                 | Session-scoped, persisted across restarts      |
| Exchange memory         | Not applicable                 | Full conversation recall with hybrid search    |
| Forgetting              | Manual deletion                | Confidence decay + consolidation               |
| Visualizer              | External tooling needed        | Built-in infinite canvas at /visualizer        |
| Search                  | Vector only                    | Hybrid BM25 + semantic (local, no API needed)  |
| Setup                   | Managed service or heavy infra | Single JSON file, zero external dependencies   |
| Cost                    | Per-query pricing or hosting   | Free, runs locally                             |

The right mental model: **a vector DB is a library** (stores documents for lookup). **forkscout-memory-mcp is a brain** (maintains beliefs, learns from corrections, tracks confidence, remembers conversations, and visualizes the full knowledge graph in a browser).

---

## Semantic Triples vs RDF vs Graph DB vs This Project

### The Triple Model

The basic unit of relational knowledge is a **triple**: `Subject → Predicate → Object`

```text
forkscout-memory-mcp  →  uses  →  TypeScript
```

In this project: `{ from: "forkscout-memory-mcp", type: "uses", to: "TypeScript" }`

### RDF

RDF is the formal standard for triples using URIs and shared vocabularies. This project is triple-like but **not RDF** — no SPARQL, no ontology layer, no URI requirement. Intentionally lightweight for fast agent workflows.

### Graph Database

Graph DBs (Neo4j, JanusGraph) store nodes and edges optimized for traversal queries at scale. This project uses a graph-shaped model stored in JSON — not a high-scale graph engine, but trivially portable and zero-dependency.

### What This Project Actually Is

forkscout-memory-mcp is a **hybrid agent memory system** layered on top of a graph:

1. **Graph layer** — entities + typed relations (120+ types)
2. **Belief layer** — facts with confidence, recency, and source counts
3. **Revision layer** — old beliefs become superseded instead of deleted
4. **Conversation layer** — important exchanges stored + searchable via hybrid search
5. **Executive layer** — active tasks survive across sessions
6. **Working layer** — short-term session context persisted across restarts

### Side-by-Side

| Model                    | Best unit of knowledge            | Best for                           | Missing vs this project                                 |
| ------------------------ | --------------------------------- | ---------------------------------- | ------------------------------------------------------- |
| **Semantic triples**     | `Subject → Predicate → Object`    | Clean relational statements        | No confidence, no history, no task/exchange memory      |
| **RDF**                  | Standardized triples with URIs    | Interoperability, formal semantics | Too rigid/heavy for fast agent memory workflows         |
| **Graph DB**             | Nodes + edges + traversal queries | Large-scale graph analytics        | Doesn't model belief revision, confidence, or exchanges |
| **forkscout-memory-mcp** | Graph + facts + exchanges + tasks | Persistent agent memory + learning | Not formal RDF, not a high-scale graph engine           |

In one line: this is not just an SPO graph — it is an SPO graph plus **confidence, recency, contradiction handling, correction history, conversation memory, working memory, task tracking, and a built-in visualizer**.

---

## License

MIT
