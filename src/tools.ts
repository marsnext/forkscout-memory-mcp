/**
 * MCP tool registration — registers memory tools on the McpServer.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from './store.js';
import type { ConsolidationReport, ContradictionWarning } from './store.js';
import { RELATION_TYPES } from './types.js';

/** Format contradiction warnings into a readable string. */
function formatContradictions(warnings: ContradictionWarning[]): string {
    if (warnings.length === 0) return '';
    return '\n⚠️ CONTRADICTIONS DETECTED:\n' + warnings.map(w =>
        `  • "${w.existingFact}" vs "${w.newFact}" — ${w.reason}`
    ).join('\n');
}

export function registerTools(server: McpServer, store: MemoryStore): void {
    // ── Knowledge ────────────────────────────────────

    server.tool('save_knowledge', 'Save a fact or observation to long-term memory. Facts are stored in the knowledge graph and can be searched later.', {
        fact: z.string().describe('Fact to store. Be specific and self-contained.'),
        category: z.string().optional().describe('Category: user-preference, project-context, decision, etc.'),
        project: z.string().optional().describe('Project name this fact belongs to (e.g. "forkscout"). Omit for universal knowledge.'),
        scope: z.enum(['project', 'universal']).optional().describe('Scope: "project" for project-specific, "universal" for cross-project knowledge. Default: inferred from project param.'),
    }, async ({ fact, category, project, scope }) => {
        const tagged = category ? `[${category}] ${fact}` : fact;
        const tags: Record<string, string> = {};
        if (project) tags.project = project;
        if (scope) tags.scope = scope;
        else if (!project) tags.scope = 'universal'; // no project → universal by default
        const hits = store.searchEntities(fact, 1);
        let contradictions: ContradictionWarning[] = [];
        if (hits.length > 0) {
            const result = store.addEntity(hits[0].name, hits[0].type, [tagged], Object.keys(tags).length > 0 ? tags : undefined);
            contradictions = result.contradictions;
        } else {
            store.addEntity(category || 'knowledge', 'concept', [tagged], Object.keys(tags).length > 0 ? tags : undefined);
        }
        await store.flush();
        return { content: [{ type: 'text' as const, text: `Saved: ${fact}${formatContradictions(contradictions)}` }] };
    });

    server.tool('search_knowledge', 'Search long-term memory for facts, entities, and past conversations. Returns ranked results by relevance. Supports project-scoped filtering.', {
        query: z.string().describe('Natural language search query.'),
        limit: z.number().optional().describe('Max results (default: 5).'),
        project: z.string().optional().describe('Filter by project name. Returns project-specific + universal results.'),
    }, async ({ query, limit, project }) => {
        const filter = project ? { project } : undefined;
        const results = store.searchKnowledge(query, limit || 5, filter);
        const text = results.length === 0
            ? 'No relevant memories found.'
            : results.map((r, i) => `${i + 1}. [${r.relevance}%, ${r.source}] ${r.content}`).join('\n');
        return { content: [{ type: 'text' as const, text }] };
    });

    // ── Entities ─────────────────────────────────────

    server.tool('add_entity', 'Add or update a named entity (person, project, technology, etc.) with associated facts in the knowledge graph. Contradictory old facts are automatically superseded (marked as historical) by new ones — they are retained for learning, not deleted.', {
        name: z.string().describe('Entity name'),
        type: z.enum(['person', 'project', 'technology', 'preference', 'concept', 'file', 'service', 'organization', 'other']),
        facts: z.array(z.string()).describe('Facts about this entity'),
        tags: z.record(z.string()).optional().describe('Tags for scoped search (e.g. { project: "forkscout", scope: "universal" })'),
    }, async ({ name, type, facts, tags }) => {
        const { entity: e, contradictions } = store.addEntity(name, type, facts, tags);
        await store.flush();
        const activeFacts = e.facts.filter(f => f.status === 'active').length;
        const supersededFacts = e.facts.filter(f => f.status === 'superseded').length;
        let text = `Entity "${e.name}" (${e.type}): ${activeFacts} active facts`;
        if (supersededFacts > 0) text += `, ${supersededFacts} historical`;
        if (contradictions.length > 0) text += ` (${contradictions.length} old fact(s) superseded — retained as history)`;
        text += formatContradictions(contradictions);
        return { content: [{ type: 'text' as const, text }] };
    });

    server.tool('update_entity', 'Replace a specific fact on an entity. Use when correcting wrong information. Old facts are superseded (retained as history for learning), not deleted. Finds active facts containing oldFact substring and supersedes them.', {
        name: z.string().describe('Entity name'),
        oldFact: z.string().describe('Substring of the old/wrong fact to find and supersede'),
        newFact: z.string().describe('New correct fact to add'),
    }, async ({ name, oldFact, newFact }) => {
        const { removed, added } = store.replaceFact(name, oldFact, newFact);
        await store.flush();
        if (removed === 0 && !added) return { content: [{ type: 'text' as const, text: `Entity "${name}" not found.` }] };
        if (removed === 0) return { content: [{ type: 'text' as const, text: `No active facts matching "${oldFact}" found on "${name}". Added new fact anyway.` }] };
        return { content: [{ type: 'text' as const, text: `Updated "${name}": superseded ${removed} old fact(s) matching "${oldFact}" (retained as history), added: "${newFact}"` }] };
    });

    server.tool('remove_fact', 'Supersede (mark as historical) specific facts from an entity by substring match. Facts are retained for learning history, not permanently deleted.', {
        name: z.string().describe('Entity name'),
        factSubstring: z.string().describe('Substring to match against active facts — matching facts will be superseded'),
    }, async ({ name, factSubstring }) => {
        const superseded = store.removeFact(name, factSubstring);
        await store.flush();
        if (superseded === 0) return { content: [{ type: 'text' as const, text: `No active facts matching "${factSubstring}" found on entity "${name}".` }] };
        return { content: [{ type: 'text' as const, text: `Superseded ${superseded} fact(s) matching "${factSubstring}" from "${name}" (retained as history).` }] };
    });

    server.tool('search_entities', 'Search for entities in the knowledge graph by name or content. Returns matching entities with their active (current) facts. Supports project-scoped filtering.', {
        query: z.string().describe('Search query'),
        limit: z.number().optional().describe('Max results (default: 5)'),
        project: z.string().optional().describe('Filter by project name. Returns project-specific + universal results.'),
    }, async ({ query, limit, project }) => {
        const filter = project ? { project } : undefined;
        const hits = store.searchEntities(query, limit || 5, filter);
        const text = hits.length === 0
            ? 'No matching entities.'
            : hits.map(e => {
                const activeFacts = e.facts.filter(f => f.status === 'active');
                const topFacts = [...activeFacts].sort((a, b) => b.confidence - a.confidence).slice(0, 5);
                const factsStr = topFacts.map(f => `${f.content} [${Math.round(f.confidence * 100)}%]`).join('; ');
                const supersededCount = e.facts.filter(f => f.status === 'superseded').length;
                const historyNote = supersededCount > 0 ? ` [${supersededCount} historical]` : '';
                return `• ${e.name} (${e.type})${historyNote}: ${factsStr}`;
            }).join('\n');
        return { content: [{ type: 'text' as const, text }] };
    });

    server.tool('get_entity', 'Get a specific entity by exact name. Shows active (current) facts by default. Use get_fact_history to see how beliefs evolved.', {
        name: z.string().describe('Entity name to look up'),
        includeHistory: z.boolean().optional().describe('Include superseded (historical) facts (default: false)'),
    }, async ({ name, includeHistory }) => {
        const e = store.getEntity(name);
        if (!e) return { content: [{ type: 'text' as const, text: `Entity "${name}" not found.` }] };
        const activeFacts = e.facts.filter(f => f.status === 'active');
        const supersededFacts = e.facts.filter(f => f.status === 'superseded');
        const activeLines = [...activeFacts]
            .sort((a, b) => b.confidence - a.confidence)
            .map(f => `  • [${Math.round(f.confidence * 100)}%] ${f.content} (${f.sources}x confirmed)`)
            .join('\n');
        let text = `${e.name} (${e.type}, seen ${e.accessCount}x, ${activeFacts.length} active, ${supersededFacts.length} historical):\n${activeLines}`;
        if (includeHistory && supersededFacts.length > 0) {
            const historyLines = [...supersededFacts]
                .sort((a, b) => (b.supersededAt || 0) - (a.supersededAt || 0))
                .map(f => {
                    const when = f.supersededAt ? new Date(f.supersededAt).toISOString().slice(0, 10) : 'unknown';
                    return `  ⤷ [superseded ${when}] ${f.content} → replaced by: ${f.supersededBy || 'unknown'}`;
                })
                .join('\n');
            text += `\n\nHistory (superseded facts):\n${historyLines}`;
        }
        return { content: [{ type: 'text' as const, text }] };
    });

    // ── Tasks ────────────────────────────────────────

    server.tool('start_task', 'Start tracking an active task. Resumes if a similar task already exists. Used for executive memory.', {
        title: z.string().describe('Short label (3-7 words)'),
        goal: z.string().describe('What you are trying to accomplish'),
        successCondition: z.string().optional().describe('How to know when done'),
        priority: z.number().min(0).max(1).optional().describe('Priority 0-1. Higher = more important/urgent.'),
        importance: z.number().min(0).max(1).optional().describe('Long-term importance 0-1. Higher = more significant to remember.'),
    }, async ({ title, goal, successCondition, priority, importance }) => {
        const similar = store.tasks.findSimilar(title, goal);
        if (similar && similar.status === 'running') {
            store.tasks.heartbeat(similar.id);
            return { content: [{ type: 'text' as const, text: `⚡ Resuming "${similar.title}" (${similar.id}) — already running` }] };
        }
        const task = store.tasks.create(title, goal, { successCondition, priority, importance });
        await store.flush();
        const pStr = priority !== undefined ? ` P${Math.round(priority * 100)}` : '';
        return { content: [{ type: 'text' as const, text: `✓ Started: "${task.title}" (${task.id})${pStr}` }] };
    });

    server.tool('complete_task', 'Mark a task as completed with an optional outcome summary.', {
        taskId: z.string().describe('Task ID'),
        result: z.string().optional().describe('Outcome summary'),
    }, async ({ taskId, result }) => {
        const task = store.tasks.complete(taskId, result);
        if (!task) return { content: [{ type: 'text' as const, text: `Task ${taskId} not found.` }] };
        await store.flush();
        const mins = Math.round((Date.now() - task.startedAt) / 60000);
        return { content: [{ type: 'text' as const, text: `✓ Completed "${task.title}" in ${mins}min` }] };
    });

    server.tool('abort_task', 'Abort a running task and record the reason it was stopped.', {
        taskId: z.string().describe('Task ID'),
        reason: z.string().describe('Why the task was stopped'),
    }, async ({ taskId, reason }) => {
        const task = store.tasks.abort(taskId, reason);
        if (!task) return { content: [{ type: 'text' as const, text: `Task ${taskId} not found.` }] };
        await store.flush();
        return { content: [{ type: 'text' as const, text: `✗ Aborted "${task.title}": ${reason}` }] };
    });

    server.tool('check_tasks', 'List all active tasks with their status, duration, and goals.', {}, async () => {
        const summary = store.tasks.summary();
        const text = summary
            ? `${summary}\n\nTotal: ${store.tasks.totalCount} (${store.tasks.runningCount} running)`
            : 'No active tasks.';
        return { content: [{ type: 'text' as const, text }] };
    });

    // ── Stats ────────────────────────────────────────

    server.tool('memory_stats', 'Show memory statistics: entity count, relation count, exchange count, active tasks, fact breakdown (active vs superseded), and type breakdown.', {}, async () => {
        const entities = store.getAllEntities();
        const types = new Map<string, number>();
        let totalActive = 0;
        let totalSuperseded = 0;
        for (const e of entities) {
            types.set(e.type, (types.get(e.type) || 0) + 1);
            totalActive += e.facts.filter(f => f.status === 'active').length;
            totalSuperseded += e.facts.filter(f => f.status === 'superseded').length;
        }
        const breakdown = Array.from(types.entries()).map(([t, c]) => `  ${t}: ${c}`).join('\n');
        return {
            content: [{
                type: 'text' as const,
                text: `Entities: ${store.entityCount}\nRelations: ${store.relationCount}\nExchanges: ${store.exchangeCount}\nActive tasks: ${store.tasks.runningCount}\nFacts: ${totalActive} active, ${totalSuperseded} superseded (historical)\n\nBreakdown:\n${breakdown || '  (none)'}`,
            }],
        };
    });

    // ── Agent internal tools (exchange tracking, relations, self-identity) ──

    server.tool('add_exchange', 'Record a user/assistant conversation exchange for later recall and context building.', {
        user: z.string().describe('User message text'),
        assistant: z.string().describe('Assistant response text'),
        sessionId: z.string().describe('Session identifier'),
        importance: z.number().min(0).max(1).optional().describe('Importance score 0-1 (default: auto). Higher = more likely to surface in search.'),
        project: z.string().optional().describe('Project name this exchange belongs to.'),
    }, async ({ user, assistant, sessionId, importance, project }) => {
        const tags = project ? { project } : undefined;
        store.addExchange(user, assistant, sessionId, importance, tags);
        await store.flush();
        return { content: [{ type: 'text' as const, text: `Exchange recorded${importance !== undefined ? ` (importance: ${Math.round(importance * 100)}%)` : ''}.` }] };
    });

    server.tool('search_exchanges', 'Search past conversation exchanges by content. Returns matching user/assistant message pairs. Supports project-scoped filtering.', {
        query: z.string().describe('Search query'),
        limit: z.number().optional().describe('Max results (default: 5)'),
        project: z.string().optional().describe('Filter by project name. Returns project-specific + universal results.'),
    }, async ({ query, limit, project }) => {
        const filter = project ? { project } : undefined;
        const hits = store.searchExchanges(query, limit || 5, filter);
        if (hits.length === 0) return { content: [{ type: 'text' as const, text: '[]' }] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(hits) }] };
    });

    server.tool('add_relation', 'Create a typed relationship between two entities in the knowledge graph (e.g. "Alice uses TypeScript").', {
        from: z.string().describe('Source entity name'),
        to: z.string().describe('Target entity name'),
        type: z.enum(RELATION_TYPES).describe('Relation type'),
    }, async ({ from, to, type }) => {
        // Auto-create entities if missing
        if (!store.getEntity(from)) store.addEntity(from, 'other', []);
        if (!store.getEntity(to)) store.addEntity(to, 'other', []);
        const rel = store.addRelation(from, type, to);
        await store.flush();
        const wStr = rel.evidenceCount > 1 ? ` (weight: ${Math.round(rel.weight * 100)}%, ${rel.evidenceCount}x confirmed)` : '';
        return { content: [{ type: 'text' as const, text: `Relation: ${from} → ${rel.type} → ${to}${wStr}` }] };
    });

    server.tool('get_all_entities', 'List all entities in the knowledge graph with their types and facts.', {
        limit: z.number().optional().describe('Max entities to return'),
    }, async ({ limit }) => {
        const all = store.getAllEntities();
        const subset = limit ? all.slice(0, limit) : all;
        return { content: [{ type: 'text' as const, text: JSON.stringify(subset) }] };
    });

    server.tool('get_all_relations', 'List all relationships between entities in the knowledge graph.', {}, async () => {
        return { content: [{ type: 'text' as const, text: JSON.stringify(store.getAllRelations()) }] };
    });

    server.tool('get_self_entity', 'Get the agent\'s own identity entity with all learned facts and self-observations.', {}, async () => {
        const self = store.getSelfEntity();
        return { content: [{ type: 'text' as const, text: JSON.stringify(self) }] };
    });

    server.tool('self_observe', 'Record a self-observation or learned behavior on the agent\'s own identity entity.', {
        content: z.string().describe('Self-observation text'),
    }, async ({ content }) => {
        store.addSelfObservation(content);
        await store.flush();
        return { content: [{ type: 'text' as const, text: `Self-observation recorded.` }] };
    });

    // ── Memory intelligence tools ────────────────────

    server.tool('get_fact_history', 'See how beliefs about an entity evolved over time. Shows supersession chains: which facts replaced which, and when. Useful for understanding learning patterns and past corrections.', {
        name: z.string().describe('Entity name to inspect'),
    }, async ({ name }) => {
        const history = store.getFactHistory(name);
        if (!history) return { content: [{ type: 'text' as const, text: `Entity "${name}" not found.` }] };
        if (history.superseded.length === 0) {
            return { content: [{ type: 'text' as const, text: `"${name}" has ${history.active.length} active facts and no correction history.` }] };
        }
        const lines: string[] = [
            `Fact history for "${name}":`,
            `  Active facts: ${history.active.length}`,
            `  Superseded facts: ${history.superseded.length}`,
            `  Correction chains: ${history.chains.length}`,
        ];
        if (history.chains.length > 0) {
            lines.push('');
            for (const chain of history.chains) {
                lines.push(`  ✓ Current: ${chain.current.content}`);
                for (const prev of chain.previous) {
                    const when = prev.supersededAt ? new Date(prev.supersededAt).toISOString().slice(0, 10) : '?';
                    lines.push(`    ← Was: "${prev.content}" (superseded ${when}, had ${prev.sources}x confirmations)`);
                }
            }
        }
        // Show orphan superseded facts (no chain to a current active fact)
        const chainedSuperseded = new Set(history.chains.flatMap(c => c.previous.map(p => p.content)));
        const orphans = history.superseded.filter(s => !chainedSuperseded.has(s.content));
        if (orphans.length > 0) {
            lines.push(`\n  Orphan superseded facts (no current replacement):`);
            for (const o of orphans) {
                const when = o.supersededAt ? new Date(o.supersededAt).toISOString().slice(0, 10) : '?';
                lines.push(`    ⤓ "${o.content}" → ${o.supersededBy || '(unknown replacement)'} (${when})`);
            }
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    });

    server.tool('consolidate_memory', 'Run memory consolidation: refresh confidence scores, archive very old superseded facts, prune stale low-confidence active facts, remove orphan relations, detect near-duplicate entities. Superseded facts are preserved for learning history (only archived after 180+ days by default).', {
        minConfidence: z.number().min(0).max(1).optional().describe('Minimum confidence to keep an active fact (default: 0.15)'),
        maxStaleDays: z.number().optional().describe('Max age in days for low-confidence active facts before pruning (default: 60)'),
        archiveDays: z.number().optional().describe('Max age in days for superseded facts before archiving (default: 180)'),
    }, async ({ minConfidence, maxStaleDays, archiveDays }) => {
        const report = store.consolidate({ minConfidence, maxStaleDays, archiveDays });
        await store.flush();
        const lines: string[] = [
            `Consolidation complete:`,
            `  Confidence refreshed: ${report.factsRefreshed} facts`,
            `  Facts pruned: ${report.factsPruned}`,
            `  Empty entities removed: ${report.entitiesRemoved}`,
            `  Orphan relations removed: ${report.relationsRemoved}`,
        ];
        if (report.duplicatesFound.length > 0) {
            lines.push(`  Potential duplicates:`);
            for (const d of report.duplicatesFound) {
                lines.push(`    • "${d.entityA}" ≈ "${d.entityB}" (${Math.round(d.similarity * 100)}% similar)`);
            }
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    });

    server.tool('get_stale_entities', 'Find entities that haven\'t been accessed or confirmed recently. Useful for identifying outdated information that needs verification.', {
        maxAgeDays: z.number().optional().describe('Max age in days since last seen (default: 30)'),
        types: z.array(z.string()).optional().describe('Only return specific entity types (e.g. ["file", "technology"])'),
        limit: z.number().optional().describe('Max results (default: 20)'),
    }, async ({ maxAgeDays, types, limit }) => {
        const stale = store.getStaleEntities({
            maxAgeDays,
            types: types as any,
            limit: limit ?? 20,
        });
        if (stale.length === 0) return { content: [{ type: 'text' as const, text: 'No stale entities found.' }] };
        const lines = stale.map(e => {
            const days = Math.round((Date.now() - e.lastSeen) / (1000 * 60 * 60 * 24));
            const topFact = e.facts.length > 0 ? e.facts[0].content.slice(0, 80) : '(no facts)';
            return `• ${e.name} (${e.type}) — ${days}d stale, ${e.accessCount} accesses — ${topFact}`;
        });
        return { content: [{ type: 'text' as const, text: `${stale.length} stale entities:\n${lines.join('\n')}` }] };
    });

    // clear_all intentionally removed — too destructive to expose as an agent-callable tool.
    // Memory can still be cleared via the admin HTTP endpoint POST /api/memory/clear.
}
