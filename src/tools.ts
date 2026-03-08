/**
 * MCP tool registration — 8 unified tools for intelligent agent memory.
 *
 * Design: fewer, more composable tools = less cognitive overhead for the agent.
 *
 *   1. remember    — store / update / supersede entity facts
 *   2. recall      — multi-modal retrieval: search, entity, history, relations, exchanges, timeline
 *   3. relate      — create typed knowledge-graph relationships
 *   4. task        — executive memory: start / complete / abort / list tasks
 *   5. observe     — record conversation exchange into long-term memory
 *   6. context     — working memory: push / get / clear session context (persisted across restarts)
 *   7. introspect  — stats, stale entities, knowledge gaps
 *   8. consolidate — memory maintenance: confidence refresh, pruning, deduplication
 *   9. forget      — permanently remove entities, facts, relations, or exchanges
 *
 * Intelligence features active automatically (no extra tool calls needed):
 *   • BM25 scoring — much better relevance than keyword overlap
 *   • Auto-relation inference on new entities (co-occurrence + dependency patterns)
 *   • Failure post-mortems auto-saved when tasks are aborted
 *   • Success records auto-saved when tasks are completed
 *   • Knowledge gap detection for volatile facts (ports, versions, paths, env vars)
 *   • Working memory auto-pushed to context on observe()
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from './store.js';
import type { ContradictionWarning } from './store.js';
import { RELATION_TYPES, SELF_ENTITY_NAME } from './types.js';

function contradictionNote(warnings: ContradictionWarning[]): string {
    if (warnings.length === 0) return '';
    return '\n⚠️ Contradictions auto-resolved:\n' + warnings.map(w =>
        `  • old: "${w.existingFact}" → superseded by: "${w.newFact}"\n    reason: ${w.reason}`
    ).join('\n');
}

export function registerTools(server: McpServer, store: MemoryStore): void {

    // ── 1. REMEMBER ──────────────────────────────────────────────────────────

    server.tool('remember',
        'Store, update, or supersede facts on a named entity in the knowledge graph. ' +
        'If the entity exists, new facts are merged and contradictions auto-resolved. ' +
        'To UPDATE: pass supersede="old fact substring" + facts=["replacement"]. ' +
        'To REMOVE: pass facts=[] + supersede="substring to drop". ' +
        `Use entity name "${SELF_ENTITY_NAME}" to record self-observations. ` +
        'RULE: Call recall(mode="search") first — avoid creating duplicate entities.',
        {
            name: z.string().describe('Entity name — use exact existing name to merge, new name to create'),
            type: z.enum(['person', 'project', 'technology', 'preference', 'concept',
                'file', 'service', 'organization', 'goal', 'decision',
                'constraint', 'skill', 'failure', 'success', 'event', 'other'])
                .describe('Entity type'),
            facts: z.array(z.string()).describe('Facts to add / merge'),
            tags: z.record(z.string()).optional()
                .describe('Scoped tags e.g. {project:"forkscout", scope:"universal"}'),
            supersede: z.string().optional()
                .describe('Substring of the fact to replace with facts[0]. Use for corrections.'),
        },
        async ({ name, type, facts, tags, supersede }) => {
            let text: string;
            let warnings: ContradictionWarning[] = [];

            if (supersede !== undefined) {
                const newFact = facts[0] ?? '';
                const { removed, added } = store.replaceFact(name, supersede, newFact);
                await store.flush();
                if (removed === 0 && !added)
                    return { content: [{ type: 'text' as const, text: `Entity "${name}" not found.` }] };
                text = removed > 0
                    ? `Updated "${name}": superseded ${removed} fact(s) matching "${supersede}", added: "${newFact}"`
                    : `"${supersede}" not found on "${name}" — added "${newFact}" as new fact.`;
            } else {
                if (facts.length === 0)
                    return { content: [{ type: 'text' as const, text: 'Pass facts[] to add or supersede= to remove.' }] };
                const result = store.addEntity(name, type as any, facts, tags);
                warnings = result.contradictions;
                const e = result.entity;
                await store.flush();
                const active = e.facts.filter(f => f.status === 'active').length;
                const superseded = e.facts.filter(f => f.status === 'superseded').length;
                text = `"${e.name}" (${e.type}): ${active} active facts`;
                if (superseded > 0) text += `, ${superseded} historical`;
                if (warnings.length > 0) text += ` — ${warnings.length} contradiction(s) auto-resolved`;
            }
            return { content: [{ type: 'text' as const, text: text + contradictionNote(warnings) }] };
        });

    // ── 2. RECALL ────────────────────────────────────────────────────────────

    server.tool('recall',
        'Multi-modal retrieval across all memory. ' +
        'mode="search" (default): BM25 search across entities + conversation history. ' +
        'mode="entity": get one entity by exact name (requires name=); optional query= filters facts. ' +
        'mode="history": belief evolution — what was corrected and when (requires name=). ' +
        'mode="relations": knowledge graph edges (optional name= restricts to one entity). ' +
        'mode="exchanges": browse or search conversation history. ' +
        'Call without query= to list all exchanges newest-first (use offset= + limit= to paginate). ' +
        'Call with query= to filter by keyword. Response always includes total count and pool size. ' +
        'mode="timeline": chronological activity feed — recent exchanges + entity accesses merged by time.',
        {
            query: z.string().optional().describe('Search text (required for mode=search; optional for mode=exchanges — omit to list all)'),
            mode: z.enum(['search', 'entity', 'history', 'relations', 'exchanges', 'timeline'])
                .optional().describe('Retrieval mode (default: search)'),
            name: z.string().optional().describe('Entity name for mode=entity or mode=history'),
            limit: z.number().optional().describe('Max results (default: 5)'),
            offset: z.number().optional().describe('Pagination offset for mode=exchanges (default: 0)'),
            project: z.string().optional().describe('Scope to project + universal'),
            include_history: z.boolean().optional().describe('Include superseded facts (mode=entity, default: false)'),
        },
        async ({ query, mode = 'search', name, limit, offset, project, include_history }) => {
            const filter = project ? { project } : undefined;
            const n = limit ?? 5;

            switch (mode) {

                case 'search': {
                    if (!query) return { content: [{ type: 'text' as const, text: 'query= is required for mode=search.' }] };
                    const results = await store.searchKnowledge(query, n, filter);
                    const text = results.length === 0
                        ? 'No memories found.'
                        : results.map((r, i) => `${i + 1}. [${r.relevance}%, ${r.source}] ${r.content}`).join('\n');
                    return { content: [{ type: 'text' as const, text }] };
                }

                case 'entity': {
                    if (!name) return { content: [{ type: 'text' as const, text: 'name= is required for mode=entity.' }] };
                    const e = store.getFilteredEntity(name, query, limit);
                    if (!e) return { content: [{ type: 'text' as const, text: `Entity "${name}" not found.` }] };
                    const active = e.facts.filter(f => f.status === 'active');
                    const superseded = e.facts.filter(f => f.status === 'superseded');
                    const totalActive = (e as any)._totalActiveFacts ?? active.length;
                    const filterNote = (query || limit) && totalActive > active.length
                        ? ` [${active.length}/${totalActive} facts shown]` : '';
                    const lines = [...active]
                        .sort((a, b) => b.confidence - a.confidence)
                        .map(f => `  • [${Math.round(f.confidence * 100)}%] ${f.content} (${f.sources}x confirmed)`);
                    let text = `${e.name} (${e.type}, ${e.accessCount} accesses, ${active.length} active, ${superseded.length} historical)${filterNote}:\n${lines.join('\n')}`;
                    if (include_history && superseded.length > 0) {
                        const hLines = [...superseded]
                            .sort((a, b) => (b.supersededAt || 0) - (a.supersededAt || 0))
                            .map(f => {
                                const when = f.supersededAt ? new Date(f.supersededAt).toISOString().slice(0, 10) : '?';
                                return `  ⤷ [${when}] ${f.content} → ${f.supersededBy ?? '?'}`;
                            });
                        text += `\n\nHistory:\n${hLines.join('\n')}`;
                    }
                    return { content: [{ type: 'text' as const, text }] };
                }

                case 'history': {
                    if (!name) return { content: [{ type: 'text' as const, text: 'name= is required for mode=history.' }] };
                    const history = store.getFactHistory(name);
                    if (!history) return { content: [{ type: 'text' as const, text: `Entity "${name}" not found.` }] };
                    if (history.superseded.length === 0)
                        return { content: [{ type: 'text' as const, text: `"${name}": ${history.active.length} facts, no correction history.` }] };
                    const lines = [
                        `Belief evolution for "${name}":`,
                        `  Active: ${history.active.length}  |  Superseded: ${history.superseded.length}  |  Chains: ${history.chains.length}`,
                    ];
                    for (const chain of history.chains) {
                        lines.push(`  ✓ Current: ${chain.current.content}`);
                        for (const p of chain.previous) {
                            const when = p.supersededAt ? new Date(p.supersededAt).toISOString().slice(0, 10) : '?';
                            lines.push(`    ← Was (${when}): "${p.content}"`);
                        }
                    }
                    const chained = new Set(history.chains.flatMap(c => c.previous.map(p => p.content)));
                    const orphans = history.superseded.filter(s => !chained.has(s.content));
                    if (orphans.length > 0) {
                        lines.push('\n  Orphaned superseded facts:');
                        for (const o of orphans) {
                            const when = o.supersededAt ? new Date(o.supersededAt).toISOString().slice(0, 10) : '?';
                            lines.push(`    ⤓ (${when}) "${o.content}" → ${o.supersededBy ?? '?'}`);
                        }
                    }
                    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
                }

                case 'relations': {
                    const all = store.getAllRelations();
                    const filtered = name
                        ? all.filter(r => r.from.toLowerCase() === name.toLowerCase() || r.to.toLowerCase() === name.toLowerCase())
                        : all.slice(0, n * 10);
                    if (filtered.length === 0)
                        return { content: [{ type: 'text' as const, text: 'No relations found.' }] };
                    const lines = filtered.map(r => {
                        const w = r.evidenceCount > 1 ? ` [${Math.round(r.weight * 100)}%, ${r.evidenceCount}x]` : '';
                        return `  ${r.from} —[${r.type}]→ ${r.to}${w}`;
                    });
                    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
                }

                case 'exchanges': {
                    const off = offset ?? 0;
                    const pageSize = limit ?? 20;
                    const { total, poolSize, items } = store.listExchanges(off, pageSize, query, filter);
                    const header = `Exchanges — total: ${total} (${poolSize} searchable in-memory window)` +
                        (query ? `, filtered by: "${query}"` : '') +
                        `, showing ${off + 1}–${off + items.length} of ${query ? items.length + (off > 0 ? '+' : '') : poolSize}`;
                    if (items.length === 0) {
                        return { content: [{ type: 'text' as const, text: `${header}\nNo exchanges found.` }] };
                    }
                    const lines = items.map((ex, i) => {
                        const when = new Date(ex.timestamp).toISOString().slice(0, 16).replace('T', ' ');
                        const imp = ex.importance ? ` [imp:${Math.round(ex.importance * 100)}%]` : '';
                        const proj = ex.tags?.project ? ` [${ex.tags.project}]` : '';
                        return `#${off + i + 1}${imp}${proj} ${when}\n  U: ${ex.user.slice(0, 150)}\n  A: ${ex.assistant.slice(0, 150)}`;
                    });
                    const footer = off + items.length < (query ? poolSize : poolSize)
                        ? `\n— use offset=${off + pageSize} to see more —`
                        : '';
                    return { content: [{ type: 'text' as const, text: `${header}\n\n${lines.join('\n\n')}${footer}` }] };
                }

                case 'timeline': {
                    const lim = limit ?? 30;
                    type TEvent = { ts: number; label: string };
                    const events: TEvent[] = [];

                    // Recent exchanges (newest-first from hot pool)
                    const { items: recentEx } = store.listExchanges(0, lim);
                    for (const ex of recentEx) {
                        const when = new Date(ex.timestamp).toISOString().slice(0, 16).replace('T', ' ');
                        const imp = ex.importance ? ` [${Math.round(ex.importance * 100)}%]` : '';
                        events.push({ ts: ex.timestamp, label: `[exchange${imp}] ${when} — ${ex.user.slice(0, 100)}` });
                    }

                    // Recent entity accesses
                    const entities = store.getAllEntities()
                        .sort((a, b) => b.lastSeen - a.lastSeen)
                        .slice(0, lim);
                    for (const e of entities) {
                        const when = new Date(e.lastSeen).toISOString().slice(0, 16).replace('T', ' ');
                        events.push({ ts: e.lastSeen, label: `[entity] ${when} — ${e.name} (${e.type}, ${e.accessCount} accesses)` });
                    }

                    events.sort((a, b) => b.ts - a.ts);
                    const top = events.slice(0, lim);
                    const text = top.length === 0
                        ? 'No timeline events.'
                        : top.map(e => e.label).join('\n');
                    return { content: [{ type: 'text' as const, text }] };
                }

                default:
                    return { content: [{ type: 'text' as const, text: 'Unknown mode.' }] };
            }
        });

    // ── 3. RELATE ────────────────────────────────────────────────────────────

    server.tool('relate',
        'Create a typed edge between two entities. Duplicate edges auto-merge and gain confidence. Missing entities are auto-created.\n' +
        'Pick the MOST SPECIFIC relation. Use `related-to` only as absolute last resort.\n\n' +
        'ONTOLOGY / CLASSIFICATION (what something IS):\n' +
        '  person `is-a` human | dog `instance-of` Animal | Cat `subclass-of` Mammal\n' +
        '  "NYC" `same-as` "New York City" | "JS" `alias` JavaScript | X `different-from` Y\n\n' +
        'ATTRIBUTES / PROPERTIES (what something HAS):\n' +
        '  sky `has-color` blue | user `has-age` 30 | box `has-weight` 5kg\n' +
        '  road `has-length` 10km | file `has-size` 2MB | water `has-temperature` cold\n' +
        '  car `has-speed` 120kph | shape `has-shape` circle | fabric `has-texture` smooth\n\n' +
        'STRUCTURE / COMPOSITION (parts and containers):\n' +
        '  engine `part-of` car | car `has-part` engine | CPU `component-of` computer\n' +
        '  box `contains` items | ball `inside` box | wheel `attached-to` axle\n\n' +
        'SPATIAL / LOCATION (where something is):\n' +
        '  Paris `located-in` France | Alice `lives-in` NYC | Bob `born-in` London\n' +
        '  office `near` station | room `outside` building | A `adjacent-to` B | X `connected-to` Y\n\n' +
        'OWNERSHIP / AUTHORITY (who owns or controls):\n' +
        '  car `owned-by` Alice | tool `belongs-to` team | project `managed-by` Alice\n' +
        '  product `created-by` Bob | item `produced-by` factory | Alice `member-of` team\n' +
        '  Bob `leader-of` team | repo `controlled-by` Alice\n\n' +
        'ACTIONS / BEHAVIOR (what something does):\n' +
        '  Alice `performs` surgery | agent `builds` Docker image | bug `affects` users\n' +
        '  rain `influences` mood | firewall `prevents` access | key `enables` login\n' +
        '  Alice `communicates-with` Bob | agent `interacts-with` API\n' +
        '  Alice `works-at` Acme | Bob `studies-at` MIT | Alice `participates-in` conference\n' +
        '  person `eats` food | person `drinks` water | process `runs` | Alice `writes` code\n' +
        '  agent `destroys` cache | agent `travels-to` city | agent `acts` | agent `performs` task\n\n' +
        'TASK / GOAL / RESOURCE (agent planning):\n' +
        '  agent `pursues` goal | goal `plans` strategy | agent `executes` task\n' +
        '  blocker `blocks` task | task `requires` CPU | goal `prioritizes` goal\n\n' +
        'CAUSAL / TEMPORAL (what leads to what, when):\n' +
        '  bug `causes` crash | fix `results-in` stability | auth `leads-to` access\n' +
        '  login `precedes` dashboard | deploy `follows` test\n' +
        '  A `before` B | A `after` B | event `during` sprint | task `started-at` time\n' +
        '  task `ended-at` time | event `occurs-in` Q1 | A `depends-on` B\n\n' +
        'LEARNING / EVIDENCE (what was learned):\n' +
        '  agent `observed` pattern | model `predicted` outcome | test `confirmed` hypothesis\n' +
        '  data `contradicted` belief | B `derived-from` A | rule `generalizes` examples\n' +
        '  design `inspired-by` nature\n\n' +
        'COMPARISON (how things relate in scale/similarity):\n' +
        '  cat `similar-to` kitten | hot `opposite-of` cold | A `equal-to` B\n' +
        '  elephant `bigger-than` mouse | atom `smaller-than` molecule\n' +
        '  score `greater-than` threshold | cost `less-than` budget\n\n' +
        'PERFORMANCE / OUTCOME (results):\n' +
        '  agent `succeeded-at` task | agent `failed-at` deploy\n' +
        '  refactor `improved-by` caching | regression `degraded-by` change\n\n' +
        'SEMANTIC / REPRESENTATIONAL:\n' +
        '  flag `represents` country | dove `symbolizes` peace\n' +
        '  ruler `measures` length | formula `calculates` area | USD `converts-to` EUR\n\n' +
        'MEMORY GRAPH (agent self-knowledge):\n' +
        '  agent `uses` tool | agent `knows` Alice | Alice `owns` repo | agent `prefers` method\n' +
        '  agent `remembers` fact | agent `forgets` detail | v2 `updates` v1 | new `replaces` old\n' +
        '  agent `learned` pattern | agent `improved` skill | agent `dislikes` approach\n\n' +
        'RULE: Run recall(mode="search") on both names first to confirm they exist.',
        {
            from: z.string().describe('Source entity name'),
            type: z.enum(RELATION_TYPES).describe('Relationship type'),
            to: z.string().describe('Target entity name'),
        },
        async ({ from, type, to }) => {
            if (!store.getEntity(from)) store.addEntity(from, 'other', []);
            if (!store.getEntity(to)) store.addEntity(to, 'other', []);
            const rel = store.addRelation(from, type, to);
            await store.flush();
            const w = rel.evidenceCount > 1
                ? ` (${Math.round(rel.weight * 100)}% confidence, ${rel.evidenceCount}x confirmed)` : '';
            return { content: [{ type: 'text' as const, text: `${from} —[${rel.type}]→ ${to}${w}` }] };
        });

    // ── 4. TASK ──────────────────────────────────────────────────────────────

    server.tool('task',
        'Executive memory for multi-step work. ' +
        'action="start": begin or resume a task (finds similar existing task to avoid duplicates). ' +
        'action="done": mark completed — auto-saves a success record for future recall. ' +
        'action="abort": stop + reason — auto-saves a failure post-mortem for future learning. ' +
        'action="list": show all active and paused tasks with elapsed durations.',
        {
            action: z.enum(['start', 'done', 'abort', 'list']).describe('Operation'),
            title: z.string().optional().describe('[start] Short label (3-7 words)'),
            goal: z.string().optional().describe('[start] What you are trying to accomplish'),
            successCondition: z.string().optional().describe('[start] How to know when done'),
            priority: z.number().min(0).max(1).optional().describe('[start] Priority 0-1'),
            importance: z.number().min(0).max(1).optional().describe('[start] Long-term importance 0-1'),
            taskId: z.string().optional().describe('[done/abort] Task ID returned by start'),
            result: z.string().optional().describe('[done] Outcome summary'),
            reason: z.string().optional().describe('[abort] Why the task was stopped'),
        },
        async ({ action, title, goal, taskId, result, reason, successCondition, priority, importance }) => {
            switch (action) {

                case 'start': {
                    if (!title || !goal)
                        return { content: [{ type: 'text' as const, text: 'title= and goal= are required for action=start.' }] };
                    const before = Date.now();
                    const t = store.tasks.create(title, goal, { successCondition, priority, importance });
                    await store.flush();
                    const pStr = priority !== undefined ? ` P${Math.round(priority * 100)}` : '';
                    const isNew = t.startedAt >= before - 500;
                    return { content: [{ type: 'text' as const, text: `${isNew ? '✓ Started' : '⚡ Resumed'}: "${t.title}" (${t.id})${pStr}` }] };
                }

                case 'done': {
                    if (!taskId)
                        return { content: [{ type: 'text' as const, text: 'taskId= is required for action=done.' }] };
                    const t = store.tasks.complete(taskId, result);
                    if (!t) return { content: [{ type: 'text' as const, text: `Task "${taskId}" not found.` }] };
                    const mins = Math.round((Date.now() - t.startedAt) / 60000);
                    if (result) store.createSuccessRecord(t.title, t.goal, result, Date.now() - t.startedAt);
                    await store.flush();
                    return { content: [{ type: 'text' as const, text: `✓ Completed "${t.title}" in ${mins}min${result ? `\n  Outcome: ${result}` : ''}` }] };
                }

                case 'abort': {
                    if (!taskId)
                        return { content: [{ type: 'text' as const, text: 'taskId= is required for action=abort.' }] };
                    const t = store.tasks.abort(taskId, reason);
                    if (!t) return { content: [{ type: 'text' as const, text: `Task "${taskId}" not found.` }] };
                    store.createFailurePostmortem(t.title, t.goal, reason ?? 'no reason given', Date.now() - t.startedAt);
                    await store.flush();
                    return { content: [{ type: 'text' as const, text: `✗ Aborted "${t.title}"\n  Reason: ${reason ?? '—'}\n  Failure post-mortem saved to memory.` }] };
                }

                case 'list': {
                    const summary = store.tasks.summary();
                    const text = summary
                        ? `${summary}\n\nTotal: ${store.tasks.totalCount} (${store.tasks.runningCount} running)`
                        : 'No active tasks.';
                    return { content: [{ type: 'text' as const, text }] };
                }
            }
        });

    // ── 5. OBSERVE ───────────────────────────────────────────────────────────

    server.tool('observe',
        'Record a significant conversation exchange into long-term memory AND push to working memory. ' +
        'Only record exchanges with non-trivial decisions, root causes, or earned insights. ' +
        'Skip routine tool output (file reads, runs with no surprises). ' +
        'RULE: Call recall(mode="exchanges", query="...") first to avoid duplicates.',
        {
            user: z.string().describe('User message'),
            assistant: z.string().describe('Assistant response'),
            sessionId: z.string().describe('Session identifier'),
            importance: z.number().min(0).max(1).optional()
                .describe('Significance 0-1 (auto if omitted). Higher = surfaces first in recall.'),
            project: z.string().optional().describe('Project scope'),
        },
        async ({ user, assistant, sessionId, importance, project }) => {
            const tags = project ? { project } : undefined;
            const ex = store.addExchange(user, assistant, sessionId, importance, tags);
            if (ex === null) {
                return { content: [{ type: 'text' as const, text: 'Duplicate exchange detected (same user text within 5 min) — skipped.' }] };
            }
            store.workingMemory.push(sessionId, 'observation',
                `Q: ${user.slice(0, 120)} → A: ${assistant.slice(0, 120)}`);
            await store.flush();
            const impStr = ` (importance: ${Math.round((ex.importance ?? 0) * 100)}% — ${importance !== undefined ? 'provided' : 'auto-scored'})`;
            return { content: [{ type: 'text' as const, text: `Exchange recorded${impStr} — also pushed to working memory.` }] };
        });

    // ── 6. CONTEXT ───────────────────────────────────────────────────────────

    server.tool('context',
        'Working memory — in-RAM, session-scoped. Survives server restart (persisted to disk on flush). ' +
        'Use to track what you are doing right now: actions taken, decisions made, errors hit. ' +
        'action="push": add an event to the session window (keeps last 25 events). ' +
        'action="get": retrieve recent context — call at session start to recall where you left off. ' +
        'action="clear": reset a session.',
        {
            action: z.enum(['push', 'get', 'clear']).describe('Operation'),
            session_id: z.string().describe('Session identifier'),
            content: z.string().optional().describe('[push] What happened / decided / failed'),
            event_type: z.enum(['action', 'observation', 'decision', 'error', 'fact']).optional()
                .describe('[push] Event category (default: action)'),
            limit: z.number().optional().describe('[get] Recent events to return (default: 10)'),
        },
        async ({ action, session_id, content, event_type, limit }) => {
            switch (action) {
                case 'push': {
                    if (!content)
                        return { content: [{ type: 'text' as const, text: 'content= is required for action=push.' }] };
                    store.workingMemory.push(session_id, event_type ?? 'action', content);
                    return { content: [{ type: 'text' as const, text: `Context pushed [${event_type ?? 'action'}].` }] };
                }
                case 'get': {
                    const summary = store.workingMemory.summary(session_id, limit ?? 10);
                    return { content: [{ type: 'text' as const, text: summary }] };
                }
                case 'clear': {
                    store.workingMemory.clear(session_id);
                    return { content: [{ type: 'text' as const, text: `Working memory cleared for session "${session_id}".` }] };
                }
            }
        });

    // ── 7. INTROSPECT ────────────────────────────────────────────────────────

    server.tool('introspect',
        'Memory self-inspection. ' +
        'view="stats" (default): entity/relation/exchange counts and type breakdown. ' +
        'view="stale": entities not accessed recently (candidates for verification or pruning). ' +
        'view="gaps": volatile facts (versions, ports, paths, env vars) that may be outdated. ' +
        'view="all": combined report — recommended at session startup.',
        {
            view: z.enum(['stats', 'stale', 'gaps', 'all']).optional().describe('What to inspect (default: stats)'),
            limit: z.number().optional().describe('Max results for stale/gaps (default: 20)'),
            types: z.array(z.string()).optional().describe('[stale] Filter by entity type'),
        },
        async ({ view = 'stats', limit, types }) => {
            const lines: string[] = [];
            const lim = limit ?? 20;
            const showStats = view === 'stats' || view === 'all';
            const showStale = view === 'stale' || view === 'all';
            const showGaps = view === 'gaps' || view === 'all';

            if (showStats) {
                const entities = store.getAllEntities();
                const typeMap = new Map<string, number>();
                let totalActive = 0, totalSuperseded = 0;
                for (const e of entities) {
                    typeMap.set(e.type, (typeMap.get(e.type) || 0) + 1);
                    totalActive += e.facts.filter(f => f.status === 'active').length;
                    totalSuperseded += e.facts.filter(f => f.status === 'superseded').length;
                }
                lines.push(
                    '── Memory Stats ──────────────────────────────────────────',
                    `  Entities: ${store.entityCount}  |  Relations: ${store.relationCount}`,
                    `  Exchanges: ${store.hotExchangeCount} hot + ${store.archiveExchangeCount} archived = ${store.exchangeCount} total`,
                    `  Tasks: ${store.tasks.runningCount} running / ${store.tasks.totalCount} total`,
                    `  Facts: ${totalActive} active, ${totalSuperseded} historical`,
                    `  Working memory: ${store.workingMemory.activeSessions()} active sessions`,
                    '  Type breakdown:',
                    ...Array.from(typeMap.entries())
                        .sort((a, b) => b[1] - a[1])
                        .map(([t, c]) => `    ${t}: ${c}`),
                );
            }

            if (showStale) {
                const stale = store.getStaleEntities({ maxAgeDays: 30, types: types as any, limit: lim });
                if (lines.length > 0) lines.push('');
                lines.push('── Stale Entities (not accessed in >30d) ────────────');
                if (stale.length === 0) {
                    lines.push('  All entities accessed recently — nothing stale.');
                } else {
                    for (const e of stale) {
                        const days = Math.round((Date.now() - e.lastSeen) / 86400000);
                        const topFact = e.facts.find(f => f.status === 'active')?.content.slice(0, 80) ?? '(no facts)';
                        lines.push(`  • ${e.name} (${e.type}, ${days}d stale) — ${topFact}`);
                    }
                }
            }

            if (showGaps) {
                const gaps = store.getKnowledgeGaps(7, lim);
                if (lines.length > 0) lines.push('');
                lines.push('── Knowledge Gaps (volatile facts possibly outdated) ──');
                if (gaps.length === 0) {
                    lines.push('  All volatile facts recently verified — no gaps detected.');
                } else {
                    for (const g of gaps) {
                        const days = Math.round((Date.now() - g.lastVerified) / 86400000);
                        lines.push(`  • [${g.entityName}] "${g.factContent.slice(0, 80)}" — ${days}d old`);
                        lines.push(`    → ${g.verificationHint}`);
                    }
                }
            }

            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        });

    // ── 8. CONSOLIDATE ───────────────────────────────────────────────────────

    server.tool('consolidate',
        'Memory maintenance: refresh confidence scores, prune stale low-confidence facts, ' +
        'remove empty entities, clean orphan relations, archive old superseded facts, detect near-duplicates. ' +
        'Run periodically or when memory grows large. ' +
        'Superseded (historical) facts are only archived after archiveDays (default: 180) to preserve learning. ' +
        'To prune old exchanges: set maxExchangeAgeDays= + minExchangeImportance= (default: 0.6).',
        {
            minConfidence: z.number().min(0).max(1).optional()
                .describe('Min confidence to keep active fact (default: 0.15)'),
            maxStaleDays: z.number().optional()
                .describe('Max age in days for low-confidence facts before pruning (default: 60)'),
            archiveDays: z.number().optional()
                .describe('Min age before superseded facts are archived (default: 180)'),
            maxExchangeAgeDays: z.number().optional()
                .describe('Max age in days for low-importance exchanges (omit = no pruning)'),
            minExchangeImportance: z.number().min(0).max(1).optional()
                .describe('Min importance to keep an exchange older than maxExchangeAgeDays (default: 0.6)'),
        },
        async ({ minConfidence, maxStaleDays, archiveDays, maxExchangeAgeDays, minExchangeImportance }) => {
            const report = await store.consolidate({ minConfidence, maxStaleDays, archiveDays, maxExchangeAgeDays, minExchangeImportance });
            await store.flush();
            const lines = [
                'Consolidation complete:',
                `  Facts confidence-refreshed: ${report.factsRefreshed}`,
                `  Facts pruned: ${report.factsPruned}`,
                `  Entities removed: ${report.entitiesRemoved}`,
                `  Relations cleaned: ${report.relationsRemoved}`,
                `  Exchanges pruned: ${report.exchangesPruned}`,
            ];
            if (report.duplicatesFound.length > 0) {
                lines.push('  Potential duplicate entities:');
                for (const d of report.duplicatesFound) {
                    lines.push(`    • "${d.entityA}" ≈ "${d.entityB}" (${Math.round(d.similarity * 100)}% similar)`);
                }
            }
            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        });

    // ── 9. FORGET ────────────────────────────────────────────────────────────

    server.tool('forget',
        'Permanently remove knowledge from memory. ' +
        'action="entity": delete an entire entity and all its relations (requires name=). ' +
        'action="fact": supersede/remove specific facts matching a substring from an entity (requires name= + query=). ' +
        'action="relation": remove a specific typed edge (requires from=, relationType=, to=). ' +
        'action="exchange": remove exchange(s) matching an ID or keyword from hot + archive (requires query=). ' +
        'Use sparingly — prefer supersede= on remember for fact corrections.',
        {
            action: z.enum(['entity', 'fact', 'relation', 'exchange']).describe('What to forget'),
            name: z.string().optional().describe('[entity/fact] Entity name'),
            query: z.string().optional().describe('[fact] Fact substring to remove | [exchange] ID or keyword to match'),
            from: z.string().optional().describe('[relation] Source entity name'),
            relationType: z.string().optional().describe('[relation] Relation type string'),
            to: z.string().optional().describe('[relation] Target entity name'),
        },
        async ({ action, name, query, from, relationType, to }) => {
            switch (action) {

                case 'entity': {
                    if (!name) return { content: [{ type: 'text' as const, text: 'name= is required for action=entity.' }] };
                    const deleted = store.deleteEntity(name);
                    if (!deleted) return { content: [{ type: 'text' as const, text: `Entity "${name}" not found.` }] };
                    await store.flush();
                    return { content: [{ type: 'text' as const, text: `Entity "${name}" deleted (+ its relations removed).` }] };
                }

                case 'fact': {
                    if (!name || !query) return { content: [{ type: 'text' as const, text: 'name= and query= are required for action=fact.' }] };
                    const removed = store.removeFact(name, query);
                    if (removed === 0) return { content: [{ type: 'text' as const, text: `No facts matching "${query}" found on "${name}".` }] };
                    await store.flush();
                    return { content: [{ type: 'text' as const, text: `${removed} fact(s) superseded on "${name}" matching "${query}".` }] };
                }

                case 'relation': {
                    if (!from || !relationType || !to)
                        return { content: [{ type: 'text' as const, text: 'from=, relationType=, and to= are required for action=relation.' }] };
                    const removed = store.removeRelation(from, relationType, to);
                    if (!removed) return { content: [{ type: 'text' as const, text: `Relation "${from} -[${relationType}]→ ${to}" not found.` }] };
                    await store.flush();
                    return { content: [{ type: 'text' as const, text: `Relation "${from} -[${relationType}]→ ${to}" removed.` }] };
                }

                case 'exchange': {
                    if (!query) return { content: [{ type: 'text' as const, text: 'query= is required for action=exchange (use ID or keyword).' }] };
                    const { hotRemoved, archiveRemoved } = await store.removeExchange(query);
                    const total = hotRemoved + archiveRemoved;
                    if (total === 0) return { content: [{ type: 'text' as const, text: `No exchanges found matching "${query}".` }] };
                    await store.flush();
                    return { content: [{ type: 'text' as const, text: `Removed ${total} exchange(s) (${hotRemoved} hot + ${archiveRemoved} archived).` }] };
                }
            }
        });
}
