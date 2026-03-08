/**
 * Memory Store — single JSON persistence for entities, relations, exchanges, and tasks.
 * Supports v4→v5 migration (structured facts, weighted relations, exchange importance).
 */

import { readFile, writeFile, rename, copyFile, appendFile, mkdir, access } from 'fs/promises';
import { dirname } from 'path';
import { WorkingMemoryManager } from './working-memory.js';
import { EmbeddingManager, cosine } from './embeddings.js';
import type { Entity, EntityType, Exchange, Fact, KnowledgeGap, MemoryData, Relation, RelationType, SearchResult, LegacyMemoryDataV4, LegacyMemoryDataV5, LegacyMemoryDataV6, MemoryVisualizationSnapshot } from './types.js';
import { SELF_ENTITY_NAME } from './types.js';
import { TaskManager } from './tasks.js';

// ── Types ────────────────────────────────────────────

export interface ConsolidationReport {
    factsRefreshed: number;
    factsPruned: number;
    entitiesRemoved: number;
    relationsRemoved: number;
    exchangesPruned: number;
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

/**
 * Auto-score exchange importance from keyword signals.
 * Returns 0.40–0.85 based on how many high-signal words appear.
 * Used when the caller does not explicitly provide importance=.
 */
const IMPORTANCE_KEYWORDS = [
    'fix', 'fixed', 'root cause', 'bug', 'error', 'critical', 'decided', 'decision',
    'discovered', 'learned', 'issue', 'problem', 'solved', 'solution', 'broken',
    'crash', 'never', 'always', 'must', 'important', 'architecture', 'design',
];
function autoImportance(user: string, assistant: string): number {
    const text = (user + ' ' + assistant).toLowerCase();
    let hits = 0;
    for (const kw of IMPORTANCE_KEYWORDS) { if (text.includes(kw)) hits++; }
    if (hits >= 4) return 0.85;
    if (hits >= 2) return 0.70;
    if (hits >= 1) return 0.55;
    return 0.40;
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
        confidence: f.confidence,
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

// ── BM25 scoring ────────────────────────────────────────

/**
 * BM25-inspired term-frequency scoring with length normalisation.
 * Significantly better than raw keyword counting for longer fact texts.
 * k1=1.5 (TF saturation), b=0.75 (length normalisation).
 */
function bm25Score(terms: string[], docText: string, avgDocLen: number): number {
    const K1 = 1.5, B = 0.75;
    const words = docText.toLowerCase().split(/\s+/);
    const docLen = words.length;
    let score = 0;
    for (const term of terms) {
        let tf = 0;
        for (const w of words) { if (w.includes(term)) tf++; }
        if (tf === 0) continue;
        // BM25 TF component with length normalisation
        score += (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLen / Math.max(avgDocLen, 1))));
    }
    return score;
}

// ── Semantic enhancement (synonym expansion + stemming) ─────────────────────

/** Synonym groups for common programming / agent-memory domain terms. */
const SYNONYM_GROUPS: string[][] = [
    ['bug', 'error', 'issue', 'problem', 'defect', 'fault', 'fail', 'failure', 'exception', 'crash'],
    ['fix', 'resolve', 'patch', 'repair', 'correct', 'debug', 'solve'],
    ['implement', 'add', 'create', 'build', 'make', 'write', 'develop'],
    ['remove', 'delete', 'drop', 'clean', 'purge', 'eliminate'],
    ['update', 'upgrade', 'change', 'modify', 'edit', 'refactor'],
    ['test', 'verify', 'check', 'validate', 'assert', 'ensure'],
    ['deploy', 'ship', 'release', 'publish', 'launch'],
    ['config', 'configuration', 'setting', 'option', 'param', 'parameter'],
    ['auth', 'authentication', 'login', 'session', 'token'],
    ['db', 'database', 'storage', 'store', 'persist', 'persistence'],
    ['api', 'endpoint', 'route', 'handler', 'request', 'response'],
    ['agent', 'bot', 'assistant', 'model', 'llm', 'ai'],
    ['slow', 'performance', 'latency', 'optimize', 'fast', 'speed'],
    ['search', 'find', 'query', 'lookup', 'retrieve', 'fetch'],
    ['memory', 'context', 'recall', 'remember', 'cache'],
    ['task', 'job', 'work', 'step', 'action', 'operation'],
    ['log', 'print', 'output', 'trace', 'debug', 'console'],
    ['type', 'kind', 'category', 'class', 'interface'],
];

// Reverse-lookup: word → synonym group index
const SYNONYM_MAP = new Map<string, number>();
for (let i = 0; i < SYNONYM_GROUPS.length; i++) {
    for (const word of SYNONYM_GROUPS[i]) SYNONYM_MAP.set(word, i);
}

/** Lightweight suffix-stripping stemmer — faster + no deps vs full Porter. */
function stem(word: string): string {
    if (word.length < 5) return word;
    if (word.endsWith('tions')) return word.slice(0, -5);
    if (word.endsWith('tion')) return word.slice(0, -4);
    if (word.endsWith('ness')) return word.slice(0, -4);
    if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3);
    if (word.endsWith('ies') && word.length > 5) return word.slice(0, -3) + 'y';
    if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2);
    if (word.endsWith('er') && word.length > 5) return word.slice(0, -2);
    if (word.endsWith('ly') && word.length > 5) return word.slice(0, -2);
    if (word.endsWith('s') && word.length > 4 && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
}

/**
 * Expand query terms with their stems and synonym-group siblings.
 * A query for "fixing bugs" will also match "resolve", "defect", "patch", etc.
 */
function expandTerms(terms: string[]): string[] {
    const expanded = new Set<string>();
    for (const t of terms) {
        expanded.add(t);
        const s = stem(t);
        expanded.add(s);
        // synonym lookup on both raw and stemmed form
        const grpIdx = SYNONYM_MAP.get(t) ?? SYNONYM_MAP.get(s);
        if (grpIdx !== undefined) {
            for (const syn of SYNONYM_GROUPS[grpIdx]) expanded.add(syn);
        }
    }
    return Array.from(expanded);
}

// ── Volatile fact patterns ────────────────────────────

/** Patterns indicating a fact is likely to change over time and needs re-verification. */
const VOLATILE_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
    { pattern: /\bport\s+\d+/i, hint: 'Verify port in docker-compose.yml or config file' },
    { pattern: /\bv?\d+\.\d+\.\d+/, hint: 'Verify version in package.json or lock file' },
    { pattern: /\/[\w/.-]+\.\w{1,5}/, hint: 'Verify file path still exists on filesystem' },
    { pattern: /localhost:\d+/i, hint: 'Verify local service is running' },
    { pattern: /process\.env\./i, hint: 'Verify environment variable is set' },
    { pattern: /\benv(?:ironment)?\s+var/i, hint: 'Verify environment variable value' },
    { pattern: /\bapi[_ ]?key/i, hint: 'Verify API key is still valid' },
    { pattern: /\bbranch\b/i, hint: 'Verify git branch with: git branch --show-current' },
];

function detectVolatility(factContent: string): { volatile: boolean; hint: string } {
    for (const { pattern, hint } of VOLATILE_PATTERNS) {
        if (pattern.test(factContent)) return { volatile: true, hint };
    }
    return { volatile: false, hint: '' };
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
            if (divergent > 0 && shared > 0) {
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
    /** In-RAM working memory (session-scoped, persisted on flush). */
    readonly workingMemory = new WorkingMemoryManager();
    /** Local vector embeddings (384-dim MiniLM, persisted to disk). */
    readonly embeddings = new EmbeddingManager();

    /** Timestamp of last confidence refresh (throttle at 5 min). */
    private lastConfidenceRefresh = 0;
    private static readonly CONFIDENCE_REFRESH_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

    /** Date string (YYYY-MM-DD) of last backup — one .bak per calendar day. */
    private lastBackupDate = '';

    // ── Exchange archive (append-only JSONL, never truncates older data) ──
    /** Path to exchanges-archive.jsonl — append-only, never overwritten. */
    private archivePath: string;
    /** Exchanges waiting to be flushed to archive file (queued by addExchange). */
    private pendingArchive: Exchange[] = [];
    /** Last 500 exchanges from archive (loaded at init, kept current for searching). */
    private archiveHot: Exchange[] = [];
    /** Total number of exchanges ever written to archive. */
    private archiveCount = 0;

    constructor(filePath: string, ownerName = 'Admin') {
        this.filePath = filePath;
        this.ownerName = ownerName;
        // Derive archive path: .forkscout/memory.json → .forkscout/exchanges-archive.jsonl
        this.archivePath = filePath.replace(/\.json$/, '') + '-exchanges-archive.jsonl';
    }

    /** Text representation of an entity used for embedding. */
    private entityEmbedText(entity: Entity): string {
        const facts = entity.facts
            .filter(f => f.status === 'active')
            .map(f => f.content)
            .join('. ');
        return facts ? `${entity.name}: ${facts}` : entity.name;
    }

    /** Embed an entity in the background (fire-and-forget). */
    private embedEntityAsync(entity: Entity): void {
        const key = this.key(entity.name);
        const text = this.entityEmbedText(entity);
        this.embeddings.encode(text).then(vec => {
            if (vec) {
                this.embeddings.set(key, vec);
                // No need to set dirty here — embeddings.dirty handles persistence
            }
        }).catch(() => { /* model unavailable — silently skip */ });
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
                // Restore working memory sessions (persisted across restarts)
                if (v7.workingMemorySessions) {
                    this.workingMemory.restoreSessions(v7.workingMemorySessions);
                }
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.warn('⚠️ Memory load failed, starting fresh:', err);
            }
        }
        // ── Load exchange archive ─────────────────────────────────────
        // Only the last 500 are kept in archiveHot (for synchronous search).
        // Full archive is append-only on disk — never read in full at runtime.
        try {
            const archiveData = await readFile(this.archivePath, 'utf-8');
            const lines = archiveData.split('\n').filter(l => l.trim());
            this.archiveCount = lines.length;
            this.archiveHot = lines.slice(-500).map(l => JSON.parse(l) as Exchange);
            console.log(`📚 Archive: ${this.archiveCount} historical exchanges (last ${this.archiveHot.length} searchable)`);
        } catch { /* no archive file yet — starts empty on first run */ }

        // ── Load embeddings from disk then warm up model ──────────────
        const embeddingPath = this.filePath.replace(/\.json$/, '') + '-embeddings.json';
        await this.embeddings.init(embeddingPath);

        // Backfill embeddings for entities that don't have one yet (bg)
        for (const entity of this.entities.values()) {
            const k = this.key(entity.name);
            if (!this.embeddings.has(k)) this.embedEntityAsync(entity);
        }

        this.ensureSelfEntity();
        console.log(`🧠 Memory: ${this.entities.size} entities, ${this.relations.length} relations, ${this.exchanges.length} hot + ${this.archiveCount} archived exchanges`);
    }

    async flush(): Promise<void> {
        // Embeddings persist independently of store dirty flag (backfill + new entities)
        await this.embeddings.persist();

        if (!this.dirty && !this.tasks.isDirty()) return;

        // Auto-refresh confidence scores on every flush (throttled to once per 5 min)
        const now = Date.now();
        if (this.dirty && now - this.lastConfidenceRefresh > MemoryStore.CONFIDENCE_REFRESH_THROTTLE_MS) {
            this.refreshConfidence();
            this.lastConfidenceRefresh = now;
        }

        try {
            await mkdir(dirname(this.filePath), { recursive: true });

            // ── Flush exchange archive (append-only JSONL) ────────────────
            // Exchanges that overflowed hot memory are appended here — never discarded.
            if (this.pendingArchive.length > 0) {
                const lines = this.pendingArchive.map(ex => JSON.stringify(ex)).join('\n') + '\n';
                await appendFile(this.archivePath, lines, 'utf-8');
                this.archiveCount += this.pendingArchive.length;
                // Keep archiveHot current (last 500 from archive for searching)
                this.archiveHot.push(...this.pendingArchive);
                if (this.archiveHot.length > 500) this.archiveHot = this.archiveHot.slice(-500);
                this.pendingArchive = [];
            }

            // ── Daily backup (keep yesterday's snapshot as .bak) ──────────
            const today = new Date().toISOString().slice(0, 10);
            if (this.lastBackupDate !== today) {
                try {
                    await access(this.filePath);
                    await copyFile(this.filePath, this.filePath + '.bak');
                    this.lastBackupDate = today;
                    console.log(`💾 Daily backup → memory.json.bak`);
                } catch { /* no existing file yet — skip backup */ }
            }

            // ── Atomic write: tmp → rename (crash-safe on POSIX) ─────────
            const data: MemoryData = {
                version: 7,
                entities: Array.from(this.entities.values()),
                relations: this.relations,
                exchanges: this.exchanges.slice(-500),
                activeTasks: this.tasks.snapshot(),
                workingMemorySessions: this.workingMemory.serializeSessions(),
            };
            const tmp = this.filePath + '.tmp';
            await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
            await rename(tmp, this.filePath); // atomic on POSIX
            this.dirty = false;
            this.tasks.clearDirty();
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
        // Auto-infer relations for newly created entities (best-effort, non-blocking)
        this.inferRelations(entity);
        // Update embedding in background (fire-and-forget)
        this.embedEntityAsync(entity);
        return { entity, contradictions };
    }

    getEntity(name: string): Entity | undefined { return this.entities.get(this.key(name)); }

    deleteEntity(name: string): boolean {
        const deleted = this.entities.delete(this.key(name));
        if (deleted) {
            this.relations = this.relations.filter(r =>
                this.key(r.from) !== this.key(name) && this.key(r.to) !== this.key(name));
            this.embeddings.delete(this.key(name));
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

    removeRelation(from: string, relType: string, to: string): boolean {
        const before = this.relations.length;
        this.relations = this.relations.filter(r =>
            !(this.key(r.from) === this.key(from) && r.type === relType && this.key(r.to) === this.key(to)));
        const removed = this.relations.length < before;
        if (removed) this.dirty = true;
        return removed;
    }

    // ── Exchanges ────────────────────────────────────

    addExchange(user: string, assistant: string, sessionId: string, importance?: number, tags?: Record<string, string>): Exchange | null {
        // Duplicate guard: reject if same user text was saved within the last 5 minutes
        const userNorm = user.slice(0, 120).toLowerCase().replace(/\s+/g, ' ').trim();
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        const isDuplicate = this.exchanges.slice(-30).some(ex => {
            if (ex.timestamp < fiveMinAgo) return false;
            return ex.user.slice(0, 120).toLowerCase().replace(/\s+/g, ' ').trim() === userNorm;
        });
        if (isDuplicate) return null;

        const resolvedImportance = importance ?? autoImportance(user, assistant);
        const ex: Exchange = {
            id: `ex_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            user: user.slice(0, 2000),
            assistant: assistant.slice(0, 2000),
            timestamp: Date.now(),
            sessionId,
            importance: resolvedImportance,
            ...(tags && Object.keys(tags).length > 0 ? { tags } : {}),
        };
        this.exchanges.push(ex);
        // When hot window overflows, move oldest exchanges to pendingArchive
        // (flushed to append-only JSONL on next flush — never discarded)
        if (this.exchanges.length > 600) {
            const overflow = this.exchanges.splice(0, this.exchanges.length - 500);
            this.pendingArchive.push(...overflow);
        }
        this.dirty = true;
        return ex;
    }

    getExchanges(): Exchange[] { return this.exchanges; }

    /**
     * Remove exchange(s) from hot memory and rewrite the archive JSONL.
     * Matches by exact id OR keyword substring (if keyword.length > 5).
     */
    async removeExchange(idOrKeyword: string): Promise<{ hotRemoved: number; archiveRemoved: number }> {
        const lower = idOrKeyword.toLowerCase();
        const matchFn = (ex: Exchange): boolean => {
            if (ex.id === idOrKeyword) return true;
            if (lower.length > 5 && `${ex.user} ${ex.assistant}`.toLowerCase().includes(lower)) return true;
            return false;
        };
        const hotBefore = this.exchanges.length;
        this.exchanges = this.exchanges.filter(ex => !matchFn(ex));
        const hotRemoved = hotBefore - this.exchanges.length;
        const archiveRemoved = await this.rewriteArchive(ex => !matchFn(ex));
        if (hotRemoved + archiveRemoved > 0) this.dirty = true;
        return { hotRemoved, archiveRemoved };
    }

    /**
     * Rewrite the entire exchange archive JSONL keeping only entries that pass filter.
     * Updates archiveCount and archiveHot in memory.
     * Returns the number of entries pruned.
     */
    private async rewriteArchive(filter: (ex: Exchange) => boolean): Promise<number> {
        try {
            const raw = await readFile(this.archivePath, 'utf-8').catch(() => '');
            const lines = raw.split('\n').filter(l => l.trim());
            const kept: Exchange[] = [];
            let pruned = 0;
            for (const line of lines) {
                try {
                    const ex = JSON.parse(line) as Exchange;
                    if (filter(ex)) { kept.push(ex); } else { pruned++; }
                } catch { /* skip malformed */ }
            }
            if (pruned > 0) {
                await writeFile(this.archivePath,
                    kept.map(ex => JSON.stringify(ex)).join('\n') + (kept.length > 0 ? '\n' : ''),
                    'utf-8');
                this.archiveCount = kept.length;
                this.archiveHot = kept.slice(-500);
            }
            return pruned;
        } catch (err) {
            console.error('Archive rewrite failed:', err);
            return 0;
        }
    }

    // ── Search ───────────────────────────────────────

    /**
     * Search entities with optional tag-based filtering.
     * When filter.project is set, returns BOTH project-specific matches AND
     * entities tagged scope:"universal" (or untagged) — merged by relevance.
     */
    searchEntities(query: string, limit = 5, filter?: Record<string, string>): Entity[] {
        const q = query.toLowerCase();
        const rawTerms = q.split(/\s+/).filter(Boolean);
        const terms = expandTerms(rawTerms); // semantic: stems + synonyms
        const scored: Array<{ entity: Entity; score: number }> = [];

        // Pre-compute average active-fact char length for BM25 length normalisation
        let totalChars = 0, totalFacts = 0;
        for (const e of this.entities.values()) {
            for (const f of e.facts) {
                if (f.status === 'active') { totalChars += f.content.length; totalFacts++; }
            }
        }
        const avgFactLen = totalFacts > 0 ? totalChars / totalFacts : 60;

        for (const entity of this.entities.values()) {
            // Tag-based pre-filter: skip entities that don't match the filter
            if (filter && !this.matchesFilter(entity.tags, filter)) continue;

            let score = 0;
            const nameL = entity.name.toLowerCase();

            // Name matching (highest weight — exact > partial > term)
            if (nameL === q) score += 10;
            else if (nameL.includes(q)) score += 5;
            for (const t of terms) { if (nameL.includes(t)) score += 2; }

            // BM25 scoring over all active fact text (much better than per-word counting)
            const activeFacts = entity.facts.filter(f => f.status === 'active');
            if (activeFacts.length > 0 && terms.length > 0) {
                const factsText = activeFacts.map(f => f.content).join(' ');
                const avgConf = activeFacts.reduce((s, f) => s + f.confidence, 0) / activeFacts.length;
                // Confidence multiplier: high-confidence facts rank higher (0.5x–1.0x)
                score += bm25Score(terms, factsText, avgFactLen) * (0.5 + avgConf * 0.5);
            }

            // Recency bonus (up to +0.5 for entities accessed today)
            const ageDays = (Date.now() - entity.lastSeen) / (1000 * 60 * 60 * 24);
            score += Math.exp(-ageDays / 30) * 0.5;
            // Access frequency bonus (capped at +1.0)
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
        const terms = expandTerms(query.toLowerCase().split(/\s+/).filter(Boolean)); // semantic expansion

        // Search pool: hot exchanges + archiveHot (deduplicated by id)
        // archiveHot holds the last 500 archived — so combined pool is up to 1000 entries
        const seenIds = new Set<string>();
        const pool: Exchange[] = [];
        for (const ex of this.exchanges) { pool.push(ex); seenIds.add(ex.id); }
        for (const ex of this.archiveHot) { if (!seenIds.has(ex.id)) pool.push(ex); }

        const scored: Array<{ ex: Exchange; score: number }> = [];
        for (const ex of pool) {
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

    /**
     * List exchanges with pagination and optional keyword filter.
     * Returns total count (hot + all archived), pool size (searchable window),
     * and the paginated slice sorted by relevance (if query) or recency (if no query).
     */
    listExchanges(
        offset = 0,
        limit = 20,
        query?: string,
        filter?: Record<string, string>,
    ): { total: number; poolSize: number; items: Exchange[] } {
        // Build deduplicated pool (hot + archiveHot, newest-first)
        const seenIds = new Set<string>();
        const pool: Exchange[] = [];
        for (const ex of this.exchanges) { pool.push(ex); seenIds.add(ex.id); }
        for (const ex of this.archiveHot) { if (!seenIds.has(ex.id)) pool.push(ex); }

        // Apply optional tag filter
        const base = filter
            ? pool.filter(ex => this.matchesFilter(ex.tags, filter))
            : pool;

        let sorted: Exchange[];
        if (query && query.trim()) {
            const terms = expandTerms(query.toLowerCase().split(/\s+/).filter(Boolean));
            const scored = base.map(ex => {
                let score = 0;
                const text = `${ex.user} ${ex.assistant}`.toLowerCase();
                for (const t of terms) { if (text.includes(t)) score += 1; }
                if (ex.importance) score += ex.importance * 2;
                const ageDays = (Date.now() - ex.timestamp) / (1000 * 60 * 60 * 24);
                score += Math.exp(-ageDays / 14) * 0.5;
                return { ex, score };
            }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
            sorted = scored.map(s => s.ex);
        } else {
            // No query — sort by recency (newest first)
            sorted = [...base].sort((a, b) => b.timestamp - a.timestamp);
        }

        return {
            total: this.exchangeCount,
            poolSize: base.length,
            items: sorted.slice(offset, offset + limit),
        };
    }

    async searchKnowledge(query: string, limit = 5, filter?: Record<string, string>): Promise<SearchResult[]> {
        const results: SearchResult[] = [];

        // ── Semantic boosting: query embedding + cosine re-ranking ───────────
        // If the model is ready, compute query embedding and blend with BM25 scores.
        // If not ready (downloading / offline), falls back to BM25 only.
        let queryVec: Float32Array | null = null;
        if (this.embeddings.ready) {
            queryVec = await this.embeddings.encode(query);
        }

        const bm25Entities = this.searchEntities(query, limit * 3, filter);

        for (const e of bm25Entities) {
            const topFacts = [...e.facts]
                .filter(f => f.status === 'active')
                .sort((a, b) => b.confidence - a.confidence)
                .slice(0, 5)
                .map(f => f.content);
            const activeFacts = e.facts.filter(f => f.status === 'active');
            const avgConf = activeFacts.length > 0
                ? Math.round(activeFacts.reduce((s, f) => s + f.confidence, 0) / activeFacts.length * 100)
                : 0;

            let relevance = avgConf;
            if (queryVec) {
                const entityVec = this.embeddings.get(this.key(e.name));
                if (entityVec) {
                    const sim = cosine(queryVec, entityVec);      // −1..1
                    const simPct = Math.round((sim + 1) / 2 * 100); // 0..100
                    // Blend: 60% BM25 confidence + 40% semantic similarity
                    relevance = Math.round(avgConf * 0.6 + simPct * 0.4);
                }
            }

            results.push({
                content: `${e.name} (${e.type}, ${avgConf}% conf): ${topFacts.join('; ')}`,
                source: 'graph',
                relevance,
            });
        }

        // ── Exchange search (unchanged — BM25 only) ──────────────────────────
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

    // ── Fact filtering ────────────────────────────────

    /**
     * Score and filter active facts by relevance to a query.
     * Returns facts sorted by score (descending), limited to `limit`.
     * Each fact gets a score based on:
     *   - Term overlap with query (keyword matching)
     *   - Confidence (high-confidence facts rank higher)
     *   - Recency bonus (recently confirmed facts get a boost)
     *   - Category tag bonus (facts whose [tag] matches query terms)
     */
    private scoreFactsForQuery(facts: Fact[], query: string, limit: number): Fact[] {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) {
            // No query — return top facts by confidence + recency
            return [...facts]
                .filter(f => f.status === 'active')
                .sort((a, b) => b.confidence - a.confidence)
                .slice(0, limit);
        }

        const scored: Array<{ fact: Fact; score: number }> = [];
        for (const f of facts) {
            if (f.status !== 'active') continue;
            const contentL = f.content.toLowerCase();
            let score = 0;

            // Term matching: each query term found in fact content adds score
            for (const t of terms) {
                if (contentL.includes(t)) score += 1;
            }

            // Category tag matching: [architecture], [debugging], [user-preference] etc.
            const tagMatch = f.content.match(/^\[([\w-]+)\]/);
            if (tagMatch) {
                const tag = tagMatch[1].toLowerCase();
                for (const t of terms) {
                    if (tag.includes(t) || t.includes(tag)) score += 2;
                }
            }

            // Confidence boost: high-confidence facts rank higher
            score += f.confidence * 0.5;

            // Recency boost: recently confirmed facts get a small bump
            const ageDays = (Date.now() - f.lastConfirmed) / (1000 * 60 * 60 * 24);
            score += Math.exp(-ageDays / 30) * 0.3;

            // Source reinforcement: multi-confirmed facts rank higher
            if (f.sources >= 2) score += 0.2;

            if (score > 0) scored.push({ fact: f, score });
        }

        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(s => s.fact);
    }

    /**
     * Get an entity with optionally filtered facts.
     * If query is provided, only returns facts relevant to the query (capped at limit).
     * If no query, returns all active facts (or capped at limit if specified).
     */
    getFilteredEntity(name: string, query?: string, limit?: number): (Entity & { _totalActiveFacts?: number }) | undefined {
        const entity = this.entities.get(this.key(name));
        if (!entity) return undefined;

        const activeFacts = entity.facts.filter(f => f.status === 'active');
        const effectiveLimit = limit ?? (query ? 30 : activeFacts.length);

        if (!query && !limit) {
            // No filtering — return full entity
            return entity;
        }

        const filteredFacts = query
            ? this.scoreFactsForQuery(entity.facts, query, effectiveLimit)
            : activeFacts.sort((a, b) => b.confidence - a.confidence).slice(0, effectiveLimit);

        return {
            ...entity,
            facts: filteredFacts,
            _totalActiveFacts: activeFacts.length,
        };
    }

    // ── Self-entity ──────────────────────────────────

    getSelfEntity(query?: string, limit?: number): Entity & { _totalActiveFacts?: number } {
        this.ensureSelfEntity();
        const full = this.entities.get(this.key(SELF_ENTITY_NAME))!;
        if (!query && !limit) return full;
        return this.getFilteredEntity(SELF_ENTITY_NAME, query, limit) ?? full;
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
    /** Hot exchanges currently in memory (last 500). */
    get hotExchangeCount(): number { return this.exchanges.length; }
    /** Total exchanges ever recorded (hot + archived). */
    get exchangeCount(): number { return this.exchanges.length + this.archiveCount; }
    /** Exchanges stored in the append-only archive file. */
    get archiveExchangeCount(): number { return this.archiveCount; }

    async getVisualizationSnapshot(): Promise<MemoryVisualizationSnapshot> {
        const archivedExchanges: Exchange[] = [];
        try {
            const archiveData = await readFile(this.archivePath, 'utf-8');
            const lines = archiveData.split('\n').filter(l => l.trim());
            for (const line of lines) archivedExchanges.push(JSON.parse(line) as Exchange);
        } catch { /* no archive yet */ }

        const allExchanges = new Map<string, Exchange>();
        for (const ex of archivedExchanges) allExchanges.set(ex.id, ex);
        for (const ex of this.pendingArchive) allExchanges.set(ex.id, ex);
        for (const ex of this.exchanges) allExchanges.set(ex.id, ex);

        const staleEntities = this.getStaleEntities({ maxAgeDays: 30, limit: 200 }).map(entity => ({
            name: entity.name,
            type: entity.type,
            lastSeen: entity.lastSeen,
            accessCount: entity.accessCount,
            tags: entity.tags,
        }));
        const knowledgeGaps = this.getKnowledgeGaps(7, 200);

        return {
            generatedAt: Date.now(),
            stats: {
                entities: this.entityCount,
                relations: this.relationCount,
                exchanges: allExchanges.size,
                exchangesHot: this.hotExchangeCount,
                exchangesArchived: this.archiveExchangeCount,
                activeTasks: this.tasks.runningCount,
                staleEntities: staleEntities.length,
                knowledgeGaps: knowledgeGaps.length,
            },
            entities: Array.from(this.entities.values())
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name)),
            relations: this.relations
                .slice()
                .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
            exchanges: Array.from(allExchanges.values())
                .sort((a, b) => b.timestamp - a.timestamp),
            activeTasks: this.tasks.snapshot()
                .slice()
                .sort((a, b) => b.lastStepAt - a.lastStepAt),
            knowledgeGaps,
            staleEntities,
        };
    }

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
    async consolidate(opts: {
        /** Minimum confidence to keep a fact (default: 0.15) */
        minConfidence?: number;
        /** Max age in days for low-confidence facts before pruning (default: 60) */
        maxStaleDays?: number;
        /** Confidence threshold below which old facts are pruned (default: 0.3) */
        staleConfidenceThreshold?: number;
        /** Max age in days for superseded facts before archiving (default: 180) */
        archiveDays?: number;
        /** Max age in days for low-importance exchanges (default: undefined = no pruning) */
        maxExchangeAgeDays?: number;
        /** Min importance to keep an exchange older than maxExchangeAgeDays (default: 0.6) */
        minExchangeImportance?: number;
    } = {}): Promise<ConsolidationReport> {
        const minConf = opts.minConfidence ?? 0.15;
        const maxStaleDays = opts.maxStaleDays ?? 60;
        const staleConfThreshold = opts.staleConfidenceThreshold ?? 0.3;
        const archiveDays = opts.archiveDays ?? 180;
        const now = Date.now();

        const report: ConsolidationReport = {
            factsRefreshed: 0, factsPruned: 0, entitiesRemoved: 0,
            relationsRemoved: 0, exchangesPruned: 0, duplicatesFound: [],
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
        //    Cap at 300 names to avoid O(n²) blowup on large graphs
        const names = Array.from(this.entities.keys()).slice(0, 300);
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

        // 6. Prune old terminal tasks (keep last 50 completed/aborted)
        this.tasks.prune(50);

        // 7. Prune old low-importance exchanges (if requested)
        if (opts.maxExchangeAgeDays !== undefined) {
            const cutoff = now - opts.maxExchangeAgeDays * 24 * 60 * 60 * 1000;
            const minImp = opts.minExchangeImportance ?? 0.6;
            const keepExchange = (ex: Exchange): boolean => {
                if (ex.timestamp > cutoff) return true;
                return (ex.importance ?? 0) >= minImp;
            };
            const hotBefore = this.exchanges.length;
            this.exchanges = this.exchanges.filter(keepExchange);
            const hotPruned = hotBefore - this.exchanges.length;
            const archivePruned = await this.rewriteArchive(keepExchange);
            report.exchangesPruned = hotPruned + archivePruned;
        }

        if (report.factsPruned > 0 || report.entitiesRemoved > 0 || report.relationsRemoved > 0 || report.exchangesPruned > 0) {
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

    // ── Auto-relation inference ──────────────────────────────────────────────

    /**
     * Automatically infer relations for a newly created entity.
     * Two strategies:
     *   1. Co-occurrence: entities mentioned together in recent exchanges → 'related-to'
     *   2. Dependency pattern: "uses X" / "depends on Y" in facts → 'depends-on'
     *
     * Non-blocking — errors are swallowed so they never break addEntity.
     */
    private inferRelations(entity: Entity): void {
        try {
            const entityNameL = entity.name.toLowerCase();
            const recentExchanges = this.exchanges.slice(-50);

            // Strategy 1: co-occurrence in recent exchanges
            for (const [key, other] of this.entities) {
                if (key === this.key(entity.name)) continue;
                if (other.type === 'agent-self') continue;
                if (other.name.length < 3) continue;

                const otherNameL = other.name.toLowerCase();
                let coCount = 0;
                for (const ex of recentExchanges) {
                    const text = `${ex.user} ${ex.assistant}`.toLowerCase();
                    if (text.includes(entityNameL) && text.includes(otherNameL)) coCount++;
                }
                if (coCount >= 2) {
                    const linked = this.relations.some(r =>
                        (this.key(r.from) === this.key(entity.name) && this.key(r.to) === key) ||
                        (this.key(r.to) === this.key(entity.name) && this.key(r.from) === key));
                    if (!linked) this.addRelation(entity.name, 'related-to', other.name);
                }
            }

            // Strategy 2: dependency pattern in fact text
            const DEP = /\b(?:uses?|depends? on|requires?|built with|powered by)\s+([\w][\w\s.-]{1,25})/gi;
            for (const fact of entity.facts) {
                if (fact.status !== 'active') continue;
                let m: RegExpExecArray | null;
                while ((m = DEP.exec(fact.content)) !== null) {
                    const depName = m[1].trim().toLowerCase();
                    const target = Array.from(this.entities.values()).find(e =>
                        e.name.toLowerCase().includes(depName) ||
                        depName.includes(e.name.toLowerCase().slice(0, Math.max(4, e.name.length - 2))));
                    if (target && this.key(target.name) !== this.key(entity.name)) {
                        const exists = this.relations.some(r =>
                            this.key(r.from) === this.key(entity.name) && this.key(r.to) === this.key(target.name));
                        if (!exists) this.addRelation(entity.name, 'depends-on', target.name);
                    }
                }
            }
        } catch { /* non-blocking */ }
    }

    // ── Knowledge gaps ───────────────────────────────────────────────────────

    /**
     * Return a list of volatile facts (port numbers, versions, paths, env vars)
     * that have not been confirmed recently (> 7 days).
     * These represent the agent's "known unknowns" — things it believes but
     * should verify before acting on.
     */
    getKnowledgeGaps(staleAfterDays = 7, maxResults = 25): KnowledgeGap[] {
        const gaps: KnowledgeGap[] = [];
        const staleCutoff = Date.now() - staleAfterDays * 24 * 60 * 60 * 1000;

        for (const entity of this.entities.values()) {
            for (const fact of entity.facts) {
                if (fact.status !== 'active') continue;
                if (fact.lastConfirmed > staleCutoff) continue; // recently confirmed — fresh
                const { volatile, hint } = detectVolatility(fact.content);
                if (volatile) {
                    gaps.push({
                        entityName: entity.name,
                        factContent: fact.content,
                        volatility: 'volatile',
                        lastVerified: fact.lastConfirmed,
                        verificationHint: hint,
                    });
                }
            }
        }

        // Stalest first
        return gaps.sort((a, b) => a.lastVerified - b.lastVerified).slice(0, maxResults);
    }

    // ── Outcome records ─────────────────────────────────────────────────────

    /**
     * Auto-create a failure post-mortem entity when a task is aborted.
     * Stored as type:'failure' so it surfaces in future searches and
     * helps the agent avoid repeating the same mistakes.
     */
    createFailurePostmortem(title: string, goal: string, reason: string, durationMs: number): Entity {
        const { entity } = this.addEntity(`failure: ${title}`, 'failure', [
            `Goal: ${goal}`,
            `Failed because: ${reason}`,
            `Duration before abort: ${Math.round(durationMs / 60000)}min`,
            `[auto-postmortem] Saved when task was aborted — use this to avoid repeating the mistake`,
        ]);
        return entity;
    }

    /**
     * Auto-create a success record entity when a task is completed.
     * Stored as type:'success' so the agent can recall what approaches worked.
     */
    createSuccessRecord(title: string, goal: string, outcome: string, durationMs: number): Entity {
        const { entity } = this.addEntity(`success: ${title}`, 'success', [
            `Goal achieved: ${goal}`,
            `Outcome: ${outcome}`,
            `Duration: ${Math.round(durationMs / 60000)}min`,
            `[auto-record] Saved when task was completed — use this to replicate success`,
        ]);
        return entity;
    }
}
