/**
 * Memory Store — single JSON persistence for entities, relations, exchanges, and tasks.
 * Supports v4→v5 migration (structured facts, weighted relations, exchange importance).
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { Entity, EntityType, Exchange, Fact, MemoryData, Relation, RelationType, SearchResult, LegacyMemoryDataV4, LegacyMemoryDataV5, LegacyMemoryDataV6 } from './types.js';
import { SELF_ENTITY_NAME } from './types.js';
import { TaskManager } from './tasks.js';

// ── Types ────────────────────────────────────────────

export interface ConsolidationReport {
    factsRefreshed: number;
    factsPruned: number;
    entitiesRemoved: number;
    relationsRemoved: number;
    duplicatesFound: Array<{ entityA: string; entityB: string; similarity: number }>;
}

export interface ContradictionWarning {
    entity: string;
    existingFact: string;
    newFact: string;
    reason: string;
}

// ── Confidence helpers ───────────────────────────────

/**
 * Auto-calculate confidence from sources count and recency.
 *
 * Design: long-term knowledge should NOT decay to zero just because nobody
 * interacted for a while. A fact stated once is still valuable after 6 months.
 *
 * Guarantees:
 *   - 1 source → floor at 0.3 (never drops below, even after years)
 *   - 2 sources → floor at 0.42
 *   - 3+ sources → floor at 0.50+
 *   - Recency adds a bonus (up to +0.30) that decays over 90 days
 *   - Net effect: recently confirmed facts score higher, but old facts
 *     are never garbage-collected just by time passing.
 */
function computeConfidence(sources: number, lastConfirmedMs: number): number {
    // Base: more sources → higher confidence (diminishing returns)
    // Floor: 1 source = 0.30, 2 = 0.42, 3 = 0.50, 5+ = 0.60
    const sourceScore = Math.min(sources / 5, 1); // 0..1
    const sourceBase = 0.30 + sourceScore * 0.30;  // 0.30..0.60

    // Recency bonus: decays over 90 days (half-life ~62 days)
    // This is additive — it boosts recent facts but never hurts old ones
    const ageMs = Date.now() - lastConfirmedMs;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyBonus = Math.exp(-ageDays / 90) * 0.30; // 0..0.30

    return Math.round(Math.min(sourceBase + recencyBonus, 1) * 100) / 100;
}

/** Create a new Fact from a plain string. */
function createFact(content: string): Fact {
    const now = Date.now();
    return { content, confidence: 1.0, sources: 1, firstSeen: now, lastConfirmed: now, status: 'active' };
}

/** Migrate a v4 string fact to a structured Fact. */
function migrateFact(content: string, entityLastSeen: number): Fact {
    return {
        content,
        confidence: 0.8, // existing facts get reasonable but not perfect confidence
        sources: 1,
        firstSeen: entityLastSeen, // best guess — we don't have the original timestamp
        lastConfirmed: entityLastSeen,
        status: 'active',
    };
}

/** Migrate a v5 fact (no status field) to v6 format. Handles [SUPERSEDED] prefix cleanup. */
function migrateFactV5toV6(f: { content: string; confidence: number; sources: number; firstSeen: number; lastConfirmed: number }): Fact {
    const isSuperseded = f.content.startsWith('[SUPERSEDED');
    // Clean up [SUPERSEDED by: ...] prefix — now tracked structurally, not in content
    let content = f.content;
    let supersededBy: string | undefined;
    if (isSuperseded) {
        const match = f.content.match(/^\[SUPERSEDED by: (.+?)\] (.+)$/);
        if (match) {
            supersededBy = match[1];
            content = match[2];
        }
    }
    return {
        content,
        confidence: isSuperseded ? f.confidence : f.confidence,
        sources: f.sources,
        firstSeen: f.firstSeen,
        lastConfirmed: f.lastConfirmed,
        status: isSuperseded ? 'superseded' : 'active',
        supersededBy,
        supersededAt: isSuperseded ? f.lastConfirmed : undefined,
    };
}

/** Migrate a v4 relation to v5 (add weight, evidenceCount, lastValidated). */
function migrateRelation(r: { from: string; to: string; type: RelationType; createdAt: number }): Relation {
    return { ...r, weight: 0.5, evidenceCount: 1, lastValidated: r.createdAt };
}

/** Migrate a v4 exchange to v5 (add importance: undefined). */
function migrateExchange(ex: { id: string; user: string; assistant: string; timestamp: number; sessionId: string }): Exchange {
    return { ...ex }; // importance is optional, so undefined is fine
}

// ── File path extraction ─────────────────────────────

/** Try to extract a file path from a file entity's name or facts. */
function extractFilePath(entity: Entity): string | null {
    const name = entity.name;
    // Common patterns: entity name IS the path
    if (name.includes('/') || name.match(/\.\w{1,5}$/)) return name;
    // Or a fact contains a path
    for (const fact of entity.facts) {
        const match = fact.content.match(/(?:path|file|located at|in)\s+[`"']?([/\w.-]+\.\w+)/i);
        if (match) return match[1];
    }
    return null;
}

// ── String similarity ────────────────────────────────

/** Jaccard similarity on word-level bigrams of two normalised strings. */
function jaccardSimilarity(a: string, b: string): number {
    const bigrams = (s: string): Set<string> => {
        const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
        const bg = new Set<string>();
        for (let i = 0; i < words.length - 1; i++) bg.add(`${words[i]} ${words[i + 1]}`);
        // Also add individual words for short strings
        for (const w of words) bg.add(w);
        return bg;
    };
    const setA = bigrams(a);
    const setB = bigrams(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    for (const x of setA) { if (setB.has(x)) intersection++; }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

// ── Contradiction detection patterns ─────────────────

/** Negation prefixes that signal potential contradiction. */
const NEGATION_PATTERNS = [
    /^no longer\b/i, /^not\b/i, /^never\b/i, /^doesn'?t\b/i, /^don'?t\b/i,
    /^isn'?t\b/i, /^wasn'?t\b/i, /^aren'?t\b/i, /^cannot\b/i, /^can'?t\b/i,
    /\bdoes not\b/i, /\bdo not\b/i, /\bdid not\b/i, /\bwill not\b/i, /\bshould not\b/i,
    /\bdeprecated\b/i, /\bremoved\b/i, /\bdisabled\b/i, /\bno longer\b/i,
];

/** Detect version/number conflicts between two fact strings. */
function detectNumberConflict(a: string, b: string): boolean {
    // Extract version patterns like "v2", "2.0", "port 3210"
    const numPattern = /\b(?:v|version\s*)?(\d+(?:\.\d+)*)\b/gi;
    const extractNums = (s: string): Map<string, string> => {
        const result = new Map<string, string>();
        // Remove numbers, get the "context" key
        const stripped = s.replace(numPattern, '###');
        const matches = [...s.matchAll(numPattern)];
        const keys = stripped.split('###');
        for (let i = 0; i < matches.length && i < keys.length; i++) {
            const key = keys[i].trim().toLowerCase().replace(/\s+/g, ' ');
            if (key.length > 2) result.set(key, matches[i][1]);
        }
        return result;
    };
    const numsA = extractNums(a);
    const numsB = extractNums(b);
    for (const [key, valA] of numsA) {
        const valB = numsB.get(key);
        if (valB && valA !== valB) return true;
    }
    return false;
}

/**
 * Check if a new fact potentially contradicts an existing fact.
 * Returns a ContradictionWarning or null.
 */
function checkContradiction(existingFact: Fact, newFactStr: string): ContradictionWarning | null {
    const existing = existingFact.content.toLowerCase().trim();
    const incoming = newFactStr.toLowerCase().trim();

    // Skip very short facts (too vague to contradict)
    if (existing.length < 10 || incoming.length < 10) return null;

    // 1. Negation contradictions
    for (const pattern of NEGATION_PATTERNS) {
        if (pattern.test(incoming) && !pattern.test(existing)) {
            // Check they're about the same topic (word overlap > 40%)
            const existWords = new Set(existing.split(/\s+/));
            const incomingWords = incoming.replace(pattern, '').trim().split(/\s+/);
            const overlap = incomingWords.filter(w => existWords.has(w)).length;
            if (overlap / Math.max(existWords.size, incomingWords.length) > 0.4) {
                return {
                    entity: '', // filled by caller
                    existingFact: existingFact.content,
                    newFact: newFactStr,
                    reason: 'Negation pattern detected — new fact may negate existing fact',
                };
            }
        }
    }

    // 2. Number/version conflicts
    if (detectNumberConflict(existing, incoming)) {
        return {
            entity: '',
            existingFact: existingFact.content,
            newFact: newFactStr,
            reason: 'Number/version conflict — same context but different values',
        };
    }

    // 3. High topic overlap with different content — two facts about the same subject
    //    that say different things (e.g. "located at packages/agent/" vs "located at src/")
    const sim = jaccardSimilarity(existing, incoming);
    if (sim > 0.4 && sim < 0.95) {
        // High overlap but not near-identical — likely contradictory update
        // Extract key nouns/values (words with / or . or uppercase) to check for divergence
        const extractKeys = (s: string): Set<string> => {
            const keys = new Set<string>();
            for (const w of s.split(/\s+/)) {
                if (w.includes('/') || w.includes('.') || /^[A-Z]/.test(w) || w.match(/^\d/)) {
                    keys.add(w.toLowerCase());
                }
            }
            return keys;
        };
        const keysA = extractKeys(existingFact.content);
        const keysB = extractKeys(newFactStr);
        // If they share topic words but have divergent key values → contradiction
        if (keysA.size > 0 && keysB.size > 0) {
            let shared = 0, divergent = 0;
            for (const k of keysB) { if (keysA.has(k)) shared++; else divergent++; }
            if (divergent > 0 && shared >= 0) {
                return {
                    entity: '',
                    existingFact: existingFact.content,
                    newFact: newFactStr,
                    reason: 'Same-topic update — high word overlap with different key values',
                };
            }
        }
    }

    return null;
}

export class MemoryStore {
    private entities = new Map<string, Entity>();
    private relations: Relation[] = [];
    private exchanges: Exchange[] = [];
    private dirty = false;
    private filePath: string;
    private ownerName: string;
    readonly tasks = new TaskManager();

    /** Timestamp of last confidence refresh (throttle at 5 min). */
    private lastConfidenceRefresh = 0;
    private static readonly CONFIDENCE_REFRESH_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

    constructor(filePath: string, ownerName = 'Admin') {
        this.filePath = filePath;
        this.ownerName = ownerName;
    }

    async init(): Promise<void> {
        try {
            const raw = await readFile(this.filePath, 'utf-8');
            const data = JSON.parse(raw);

            if (data.version === 4 || !data.version) {
                // ── v4 → v6 migration ────────────────────
                console.log('🔄 Migrating memory v4 → v6 (structured facts with versioning)...');
                const v4 = data as LegacyMemoryDataV4;
                for (const e of v4.entities) {
                    const migrated: Entity = {
                        name: e.name,
                        type: e.type,
                        facts: e.facts.map(f => migrateFact(f, e.lastSeen)),
                        lastSeen: e.lastSeen,
                        accessCount: e.accessCount,
                    };
                    this.entities.set(this.key(e.name), migrated);
                }
                this.relations = (v4.relations || []).map(migrateRelation);
                this.exchanges = (v4.exchanges || []).map(migrateExchange);
                this.tasks.load(v4.activeTasks || []);
                this.dirty = true;
                console.log(`✅ Migrated ${this.entities.size} entities, ${this.relations.length} relations, ${this.exchanges.length} exchanges`);
            } else if (data.version === 5) {
                // ── v5 → v6 migration (add status field, clean [SUPERSEDED] prefixes) ──
                console.log('🔄 Migrating memory v5 → v6 (fact versioning)...');
                const v5 = data as LegacyMemoryDataV5;
                for (const e of v5.entities) {
                    const migrated: Entity = {
                        name: e.name,
                        type: e.type,
                        facts: e.facts.map(f => migrateFactV5toV6(f)),
                        lastSeen: e.lastSeen,
                        accessCount: e.accessCount,
                    };
                    this.entities.set(this.key(e.name), migrated);
                }
                this.relations = v5.relations || [];
                this.exchanges = v5.exchanges || [];
                this.tasks.load(v5.activeTasks || []);
                this.dirty = true;
                const supersededCount = Array.from(this.entities.values())
                    .reduce((sum, e) => sum + e.facts.filter(f => f.status === 'superseded').length, 0);
                console.log(`✅ Migrated ${this.entities.size} entities (${supersededCount} superseded facts preserved as history)`);
            } else if (data.version === 6) {
                // ── v6 → v7 migration (add tags field to entities/exchanges) ──
                console.log('🔄 Migrating memory v6 → v7 (multi-dimensional tags)...');
                const v6 = data as LegacyMemoryDataV6;
                for (const e of v6.entities) {
                    const migrated: Entity = { ...e };
                    // Existing entities get no tags (backwards compatible — untagged passes all filters)
                    this.entities.set(this.key(e.name), migrated);
                }
                this.relations = v6.relations || [];
                this.exchanges = (v6.exchanges || []).map(ex => ({ ...ex } as Exchange));
                this.tasks.load(v6.activeTasks || []);
                this.dirty = true;
                console.log(`✅ Migrated ${this.entities.size} entities to v7 (tags-ready)`);
            } else {
                // Already v7
                const v7 = data as MemoryData;
                for (const e of v7.entities) this.entities.set(this.key(e.name), e);
                this.relations = v7.relations || [];
                this.exchanges = v7.exchanges || [];
                this.tasks.load(v7.activeTasks || []);
            }
        } catch { /* start fresh */ }
        this.ensureSelfEntity();
        console.log(`🧠 Memory: ${this.entities.size} entities, ${this.relations.length} relations, ${this.exchanges.length} exchanges`);
    }

    async flush(): Promise<void> {
        if (!this.dirty && !this.tasks.isDirty()) return;

        // Auto-refresh confidence scores on every flush (throttled to once per 5 min)
        const now = Date.now();
        if (this.dirty && now - this.lastConfidenceRefresh > MemoryStore.CONFIDENCE_REFRESH_THROTTLE_MS) {
            this.refreshConfidence();
            this.lastConfidenceRefresh = now;
        }

        try {
            await mkdir(dirname(this.filePath), { recursive: true });
            const data: MemoryData = {
                version: 7,
                entities: Array.from(this.entities.values()),
                relations: this.relations,
                exchanges: this.exchanges.slice(-500),
                activeTasks: this.tasks.snapshot(),
            };
            this.tasks.clearDirty();
            await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
            this.dirty = false;
        } catch (err) { console.error('Memory flush failed:', err); }
    }

    async clear(): Promise<void> {
        this.entities.clear();
        this.relations = [];
        this.exchanges = [];
        this.dirty = true;
        await this.flush();
    }

    // ── Entity CRUD ──────────────────────────────────

    addEntity(name: string, type: EntityType, facts: string[], tags?: Record<string, string>): { entity: Entity; contradictions: ContradictionWarning[] } {
        const k = this.key(name);
        const existing = this.entities.get(k);
        const contradictions: ContradictionWarning[] = [];

        if (existing) {
            // Merge tags if provided (new tags override existing per-key)
            if (tags) existing.tags = { ...existing.tags, ...tags };
            for (const f of facts) {
                const match = existing.facts.find(ef =>
                    ef.status === 'active' && ef.content.toLowerCase() === f.toLowerCase());
                if (match) {
                    // Reinforce existing active fact
                    match.sources++;
                    match.lastConfirmed = Date.now();
                    match.confidence = computeConfidence(match.sources, match.lastConfirmed);
                } else {
                    // Check for contradictions against ACTIVE facts only
                    const superseded: Fact[] = [];
                    for (const ef of existing.facts) {
                        if (ef.status === 'superseded') continue; // skip already-superseded facts
                        const warning = checkContradiction(ef, f);
                        if (warning) {
                            warning.entity = name;
                            contradictions.push(warning);
                            superseded.push(ef);
                        }
                    }
                    // Mark contradicted facts as superseded — retain for learning history
                    // Confidence is preserved (historical record), content unchanged
                    const now = Date.now();
                    for (const old of superseded) {
                        old.status = 'superseded';
                        old.supersededBy = f;
                        old.supersededAt = now;
                    }
                    // Add the new (correct) fact as active
                    existing.facts.push(createFact(f));
                }
            }
            existing.lastSeen = Date.now();
            existing.accessCount++;
            this.dirty = true;
            return { entity: existing, contradictions };
        }
        const entity: Entity = {
            name, type,
            facts: facts.map(f => createFact(f)),
            lastSeen: Date.now(), accessCount: 1,
            ...(tags && Object.keys(tags).length > 0 ? { tags } : {}),
        };
        this.entities.set(k, entity);
        this.dirty = true;
        return { entity, contradictions };
    }

    getEntity(name: string): Entity | undefined { return this.entities.get(this.key(name)); }

    deleteEntity(name: string): boolean {
        const deleted = this.entities.delete(this.key(name));
        if (deleted) {
            this.relations = this.relations.filter(r =>
                this.key(r.from) !== this.key(name) && this.key(r.to) !== this.key(name));
            this.dirty = true;
        }
        return deleted;
    }

    getAllEntities(): Entity[] { return Array.from(this.entities.values()); }

    /**
     * Supersede facts on an entity by substring match.
     * Facts are marked as superseded (retained for history), NOT deleted.
     * Returns the number of facts superseded.
     */
    removeFact(entityName: string, factSubstring: string, replacedBy?: string): number {
        const entity = this.entities.get(this.key(entityName));
        if (!entity) return 0;
        const lower = factSubstring.toLowerCase();
        const now = Date.now();
        let count = 0;
        for (const f of entity.facts) {
            if (f.status === 'superseded') continue; // already superseded
            if (f.content.toLowerCase().includes(lower)) {
                f.status = 'superseded';
                f.supersededBy = replacedBy || `[manually removed: "${factSubstring}"]`;
                f.supersededAt = now;
                count++;
            }
        }
        if (count > 0) this.dirty = true;
        return count;
    }

    /**
     * Replace facts matching a substring with a new fact.
     * Old facts are marked as superseded (retained for history).
     * Returns { superseded: number, added: boolean }.
     */
    replaceFact(entityName: string, oldFactSubstring: string, newFact: string): { removed: number; added: boolean } {
        const removed = this.removeFact(entityName, oldFactSubstring, newFact);
        const entity = this.entities.get(this.key(entityName));
        if (!entity) return { removed: 0, added: false };
        entity.facts.push(createFact(newFact));
        entity.lastSeen = Date.now();
        this.dirty = true;
        return { removed, added: true };
    }

    /**
     * Get fact history for an entity — shows how beliefs evolved over time.
     * Returns all facts (active + superseded), grouped by supersession chains.
     */
    getFactHistory(entityName: string): { active: Fact[]; superseded: Fact[]; chains: Array<{ current: Fact; previous: Fact[] }> } | null {
        const entity = this.entities.get(this.key(entityName));
        if (!entity) return null;

        const active = entity.facts.filter(f => f.status === 'active');
        const superseded = entity.facts.filter(f => f.status === 'superseded');

        // Build supersession chains: active fact ← superseded facts that led to it
        const chains: Array<{ current: Fact; previous: Fact[] }> = [];
        for (const fact of active) {
            const predecessors = superseded.filter(s => s.supersededBy === fact.content);
            if (predecessors.length > 0) {
                chains.push({ current: fact, previous: predecessors.sort((a, b) => (a.supersededAt || 0) - (b.supersededAt || 0)) });
            }
        }

        return { active, superseded, chains };
    }

    /**
     * Get active (non-superseded) facts for an entity.
     * This is the "current belief" view.
     */
    getActiveFacts(entityName: string): Fact[] {
        const entity = this.entities.get(this.key(entityName));
        if (!entity) return [];
        return entity.facts.filter(f => f.status === 'active');
    }

    /**
     * Archive very old superseded facts (>archiveDays old) by removing them.
     * This is the ONLY destructive operation — used for storage management, not correction.
     * Default: archive superseded facts older than 180 days.
     */
    archiveOldSuperseded(archiveDays = 180): number {
        const cutoff = Date.now() - archiveDays * 24 * 60 * 60 * 1000;
        let archived = 0;
        for (const entity of this.entities.values()) {
            const before = entity.facts.length;
            entity.facts = entity.facts.filter(f => {
                if (f.status !== 'superseded') return true;
                // Only archive if superseded long ago
                return (f.supersededAt || f.lastConfirmed) > cutoff;
            });
            archived += before - entity.facts.length;
        }
        if (archived > 0) this.dirty = true;
        return archived;
    }

    // ── Relations ────────────────────────────────────

    addRelation(from: string, type: RelationType, to: string): Relation {
        const existing = this.relations.find(r =>
            this.key(r.from) === this.key(from) && this.key(r.to) === this.key(to) && r.type === type);
        if (existing) {
            // Reinforce: more evidence = higher weight
            existing.evidenceCount++;
            existing.lastValidated = Date.now();
            existing.weight = Math.min(existing.evidenceCount / 5, 1); // caps at 5
            this.dirty = true;
            return existing;
        }
        const rel: Relation = {
            from, to, type,
            weight: 0.5,
            evidenceCount: 1,
            lastValidated: Date.now(),
            createdAt: Date.now(),
        };
        this.relations.push(rel);
        this.dirty = true;
        return rel;
    }

    getAllRelations(): Relation[] { return this.relations; }

    // ── Exchanges ────────────────────────────────────

    addExchange(user: string, assistant: string, sessionId: string, importance?: number, tags?: Record<string, string>): Exchange {
        const ex: Exchange = {
            id: `ex_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            user: user.slice(0, 2000),
            assistant: assistant.slice(0, 2000),
            timestamp: Date.now(),
            sessionId,
            importance,
            ...(tags && Object.keys(tags).length > 0 ? { tags } : {}),
        };
        this.exchanges.push(ex);
        this.dirty = true;
        return ex;
    }

    getExchanges(): Exchange[] { return this.exchanges; }

    // ── Search ───────────────────────────────────────

    /**
     * Search entities with optional tag-based filtering.
     * When filter.project is set, returns BOTH project-specific matches AND
     * entities tagged scope:"universal" (or untagged) — merged by relevance.
     */
    searchEntities(query: string, limit = 5, filter?: Record<string, string>): Entity[] {
        const q = query.toLowerCase();
        const terms = q.split(/\s+/).filter(Boolean);
        const scored: Array<{ entity: Entity; score: number }> = [];
        for (const entity of this.entities.values()) {
            // Tag-based pre-filter: skip entities that don't match the filter
            if (filter && !this.matchesFilter(entity.tags, filter)) continue;

            let score = 0;
            const nameL = entity.name.toLowerCase();
            if (nameL === q) score += 10;
            else if (nameL.includes(q)) score += 5;
            for (const t of terms) {
                if (nameL.includes(t)) score += 2;
                for (const f of entity.facts) {
                    // Only ACTIVE facts contribute to search relevance
                    if (f.status === 'superseded') continue;
                    if (f.content.toLowerCase().includes(t)) {
                        // Weight by confidence — high-confidence facts matter more
                        score += f.confidence;
                    }
                }
            }
            // Recency bonus: recently seen entities rank higher
            const ageDays = (Date.now() - entity.lastSeen) / (1000 * 60 * 60 * 24);
            const recencyBonus = Math.exp(-ageDays / 30) * 0.5; // up to +0.5
            score += recencyBonus;
            // Access bonus (capped)
            score += Math.min(entity.accessCount * 0.1, 1);
            if (score > 0) scored.push({ entity, score });
        }
        const results = scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.entity);

        // Usage tracking: bump accessCount + lastSeen on retrieved entities
        const now = Date.now();
        for (const entity of results) {
            entity.accessCount++;
            entity.lastSeen = now;
        }
        if (results.length > 0) this.dirty = true;

        return results;
    }

    searchExchanges(query: string, limit = 5, filter?: Record<string, string>): Exchange[] {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const scored: Array<{ ex: Exchange; score: number }> = [];
        for (const ex of this.exchanges) {
            // Tag-based pre-filter
            if (filter && !this.matchesFilter(ex.tags, filter)) continue;

            let score = 0;
            const text = `${ex.user} ${ex.assistant}`.toLowerCase();
            for (const t of terms) { if (text.includes(t)) score += 1; }
            // Importance bonus
            if (ex.importance) score += ex.importance * 2;
            // Recency bonus for exchanges
            const ageDays = (Date.now() - ex.timestamp) / (1000 * 60 * 60 * 24);
            score += Math.exp(-ageDays / 14) * 0.5; // half-life ~10 days
            if (score > 0) scored.push({ ex, score });
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.ex);
    }

    searchKnowledge(query: string, limit = 5, filter?: Record<string, string>): SearchResult[] {
        const results: SearchResult[] = [];
        for (const e of this.searchEntities(query, limit, filter)) {
            // Show top ACTIVE facts by confidence
            const topFacts = [...e.facts]
                .filter(f => f.status === 'active')
                .sort((a, b) => b.confidence - a.confidence)
                .slice(0, 5)
                .map(f => f.content);
            const activeFacts = e.facts.filter(f => f.status === 'active');
            const avgConf = activeFacts.length > 0
                ? Math.round(activeFacts.reduce((s, f) => s + f.confidence, 0) / activeFacts.length * 100)
                : 0;
            results.push({
                content: `${e.name} (${e.type}, ${avgConf}% conf): ${topFacts.join('; ')}`,
                source: 'graph',
                relevance: avgConf,
            });
        }
        for (const ex of this.searchExchanges(query, limit, filter)) {
            const imp = ex.importance ? Math.round(ex.importance * 100) : 70;
            results.push({
                content: `User: ${ex.user.slice(0, 200)} → Assistant: ${ex.assistant.slice(0, 200)}`,
                source: 'exchange',
                relevance: imp,
            });
        }
        return results.sort((a, b) => b.relevance - a.relevance).slice(0, limit);
    }

    // ── Self-entity ──────────────────────────────────

    getSelfEntity(): Entity {
        this.ensureSelfEntity();
        return this.entities.get(this.key(SELF_ENTITY_NAME))!;
    }

    addSelfObservation(content: string): void {
        const self = this.getSelfEntity();
        const match = self.facts.find(f =>
            f.status === 'active' && f.content.toLowerCase() === content.toLowerCase());
        if (match) {
            // Reinforce existing observation
            match.sources++;
            match.lastConfirmed = Date.now();
            match.confidence = computeConfidence(match.sources, match.lastConfirmed);
        } else {
            self.facts.push(createFact(content));
        }
        self.lastSeen = Date.now();
        this.dirty = true;
    }

    // ── Stats ────────────────────────────────────────

    get entityCount(): number { return this.entities.size; }
    get relationCount(): number { return this.relations.length; }
    get exchangeCount(): number { return this.exchanges.length; }

    private key(name: string): string { return name.toLowerCase().trim(); }

    /**
     * Check if an item's tags match a filter.
     * Smart scoping rules:
     * - If filter has `project`, matches items with that project tag OR items with scope:"universal" OR untagged items.
     * - For all other filter keys, requires exact match.
     * - Items with no tags pass non-project filters (backwards compatible).
     */
    private matchesFilter(itemTags: Record<string, string> | undefined, filter: Record<string, string>): boolean {
        for (const [key, value] of Object.entries(filter)) {
            if (key === 'project') {
                // Smart project scoping: include project-specific + universal + untagged
                if (!itemTags) continue; // untagged items always pass project filter
                const itemProject = itemTags.project;
                const itemScope = itemTags.scope;
                if (!itemProject && !itemScope) continue; // no project/scope tags = passes
                if (itemScope === 'universal') continue;  // universal items always pass
                if (itemProject && itemProject.toLowerCase() !== value.toLowerCase()) return false;
            } else {
                // Exact match for other keys — untagged items pass (backwards compatible)
                if (!itemTags) continue;
                const itemVal = itemTags[key];
                if (itemVal && itemVal.toLowerCase() !== value.toLowerCase()) return false;
            }
        }
        return true;
    }

    /** Refresh confidence scores on all ACTIVE facts (call periodically or on read). */
    refreshConfidence(): void {
        for (const entity of this.entities.values()) {
            for (const f of entity.facts) {
                if (f.status === 'superseded') continue; // preserve historical confidence
                f.confidence = computeConfidence(f.sources, f.lastConfirmed);
            }
        }
    }

    // ── Consolidation ────────────────────────────────

    /**
     * Run memory consolidation: refresh confidence, archive very old superseded
     * facts, prune stale low-confidence active facts on non-protected entities,
     * remove orphan relations, and detect near-duplicate entities.
     * Returns a report of changes made.
     */
    consolidate(opts: {
        /** Minimum confidence to keep a fact (default: 0.15) */
        minConfidence?: number;
        /** Max age in days for low-confidence facts before pruning (default: 60) */
        maxStaleDays?: number;
        /** Confidence threshold below which old facts are pruned (default: 0.3) */
        staleConfidenceThreshold?: number;
        /** Max age in days for superseded facts before archiving (default: 180) */
        archiveDays?: number;
    } = {}): ConsolidationReport {
        const minConf = opts.minConfidence ?? 0.15;
        const maxStaleDays = opts.maxStaleDays ?? 60;
        const staleConfThreshold = opts.staleConfidenceThreshold ?? 0.3;
        const archiveDays = opts.archiveDays ?? 180;
        const now = Date.now();

        const report: ConsolidationReport = {
            factsRefreshed: 0, factsPruned: 0, entitiesRemoved: 0,
            relationsRemoved: 0, duplicatesFound: [],
        };

        // 1. Refresh all confidence scores (active facts only)
        for (const entity of this.entities.values()) {
            for (const f of entity.facts) {
                if (f.status === 'superseded') continue; // preserve historical confidence
                const old = f.confidence;
                f.confidence = computeConfidence(f.sources, f.lastConfirmed);
                if (f.confidence !== old) report.factsRefreshed++;
            }
        }

        // Entity types that should NEVER have facts pruned automatically.
        // These represent durable knowledge that remains valid over time.
        const PROTECTED_TYPES = new Set<string>([
            'agent-self', 'person', 'project', 'preference', 'decision',
            'organization', 'skill', 'constraint',
        ]);

        // 2a. Archive very old superseded facts (storage management only)
        //     These are facts that were superseded a long time ago — retained for
        //     learning history but eventually archived to manage storage.
        const archiveCutoff = now - archiveDays * 24 * 60 * 60 * 1000;
        for (const entity of this.entities.values()) {
            const before = entity.facts.length;
            entity.facts = entity.facts.filter(f => {
                if (f.status !== 'superseded') return true;
                return (f.supersededAt || f.lastConfirmed) > archiveCutoff;
            });
            report.factsPruned += before - entity.facts.length;
        }

        // 2b. Prune stale low-confidence ACTIVE facts (only on non-protected entities)
        //     Superseded facts are not touched here — they're retained for learning
        for (const entity of this.entities.values()) {
            if (PROTECTED_TYPES.has(entity.type)) continue;
            const before = entity.facts.length;
            entity.facts = entity.facts.filter(f => {
                if (f.status === 'superseded') return true; // never prune superseded in this step
                const ageDays = (now - f.lastConfirmed) / (1000 * 60 * 60 * 24);
                // Keep if: high enough confidence, OR recently confirmed, OR has multiple sources
                if (f.confidence >= staleConfThreshold) return true;
                if (ageDays < maxStaleDays) return true;
                if (f.sources >= 2) return true;
                // Below minimum confidence threshold: prune
                if (f.confidence < minConf) return false;
                return true;
            });
            report.factsPruned += before - entity.facts.length;
        }

        // 3. Remove entities with no ACTIVE facts remaining (except self-entity)
        //    An entity with only superseded facts is kept for history
        const emptyEntities: string[] = [];
        for (const [key, entity] of this.entities) {
            if (entity.type === 'agent-self') continue;
            const activeFacts = entity.facts.filter(f => f.status === 'active');
            if (activeFacts.length === 0 && entity.facts.length === 0) emptyEntities.push(key);
        }
        for (const key of emptyEntities) {
            this.entities.delete(key);
            report.entitiesRemoved++;
        }

        // 4. Remove orphan relations (referencing deleted entities)
        const beforeRels = this.relations.length;
        this.relations = this.relations.filter(r =>
            this.entities.has(this.key(r.from)) && this.entities.has(this.key(r.to)));
        report.relationsRemoved = beforeRels - this.relations.length;

        // 5. Detect near-duplicate entities (Jaccard similarity on normalized names)
        const names = Array.from(this.entities.keys());
        for (let i = 0; i < names.length; i++) {
            for (let j = i + 1; j < names.length; j++) {
                const sim = jaccardSimilarity(names[i], names[j]);
                if (sim > 0.7) {
                    const eA = this.entities.get(names[i])!;
                    const eB = this.entities.get(names[j])!;
                    // Only flag same-type entities
                    if (eA.type === eB.type) {
                        report.duplicatesFound.push({ entityA: eA.name, entityB: eB.name, similarity: sim });
                    }
                }
            }
        }

        if (report.factsPruned > 0 || report.entitiesRemoved > 0 || report.relationsRemoved > 0) {
            this.dirty = true;
        }

        return report;
    }

    // ── Stale entity detection ───────────────────────

    /**
     * Find entities that haven't been accessed or confirmed recently.
     * Useful for automated verification jobs.
     */
    getStaleEntities(opts: {
        /** Max age in days since lastSeen (default: 30) */
        maxAgeDays?: number;
        /** Only return specific types */
        types?: EntityType[];
        /** Max results */
        limit?: number;
    } = {}): Entity[] {
        const maxAge = (opts.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - maxAge;
        const results: Entity[] = [];

        for (const entity of this.entities.values()) {
            if (entity.type === 'agent-self') continue;
            if (opts.types && !opts.types.includes(entity.type)) continue;
            if (entity.lastSeen < cutoff) results.push(entity);
        }

        // Sort by stalest first
        results.sort((a, b) => a.lastSeen - b.lastSeen);
        return opts.limit ? results.slice(0, opts.limit) : results;
    }

    // ── File verification ────────────────────────────

    /**
     * Verify file-type entities against the actual filesystem.
     * Marks missing files with an auto-verified fact.
     * Runs server-side for direct fs access (no HTTP round-trips).
     */
    async verifyFileEntities(maxFiles = 50): Promise<{ filesChecked: number; filesMissing: number; factsMarked: number }> {
        const { access } = await import('fs/promises');
        const stats = { filesChecked: 0, filesMissing: 0, factsMarked: 0 };

        const fileEntities = Array.from(this.entities.values()).filter(e => e.type === 'file');
        for (const entity of fileEntities.slice(0, maxFiles)) {
            const filePath = extractFilePath(entity);
            if (!filePath) continue;
            stats.filesChecked++;
            try {
                await access(filePath);
            } catch {
                stats.filesMissing++;
                // Check if we already marked this — avoid duplicate warnings
                const alreadyMarked = entity.facts.some(f => f.content.includes('[auto-verified] File not found'));
                if (!alreadyMarked) {
                    this.addEntity(entity.name, entity.type, [
                        `[auto-verified] File not found at ${filePath} — may have been moved or deleted`,
                    ]);
                    stats.factsMarked++;
                }
            }
        }
        if (stats.factsMarked > 0) this.dirty = true;
        return stats;
    }

    private ensureSelfEntity(): void {
        if (!this.entities.has(this.key(SELF_ENTITY_NAME))) {
            this.addEntity(SELF_ENTITY_NAME, 'agent-self', [
                `AI agent created by ${this.ownerName}`,
                'Capable of running commands, editing files, web search, and scheduling tasks',
            ]);
        }
    }
}
