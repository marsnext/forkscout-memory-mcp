/**
 * Memory types — all type definitions for the memory system.
 */

export type EntityType =
    | 'person'
    | 'project'
    | 'technology'
    | 'preference'
    | 'concept'
    | 'file'
    | 'service'
    | 'organization'
    | 'agent-self'

    // NEW — cognition
    | 'goal'          // desired outcome
    | 'task'          // active work unit
    | 'plan'          // multi-step strategy
    | 'skill'         // learned capability
    | 'problem'       // detected issue
    | 'hypothesis'    // belief to test
    | 'decision'      // chosen path
    | 'constraint'    // rule or limitation

    // NEW — experience
    | 'event'         // something that happened
    | 'episode'       // grouped events
    | 'outcome'       // result of action
    | 'failure'       // negative outcome
    | 'success'       // positive outcome

    // NEW — environment
    | 'resource'      // CPU, disk, API quota, time
    | 'state'         // runtime condition
    | 'signal'        // trigger or observation

    | 'other';

export const RELATION_TYPES = [
    // existing
    'uses', 'owns', 'works-on', 'prefers', 'knows',
    'depends-on', 'created', 'related-to', 'part-of',
    'manages', 'dislikes', 'learned', 'improved',

    // NEW — intentional
    'pursues',        // agent → goal
    'plans',          // goal → plan
    'executes',       // agent → task
    'blocks',         // constraint → task
    'requires',       // task → resource
    'prioritizes',    // goal → goal

    // NEW — temporal / causal
    'causes',
    'results-in',
    'leads-to',
    'precedes',
    'follows',

    // NEW — learning
    'observed',
    'predicted',
    'confirmed',
    'contradicted',
    'generalizes',
    'derived-from',

    // NEW — performance
    'succeeded-at',
    'failed-at',
    'improved-by',
    'degraded-by',

    // NEW — memory
    'remembers',
    'forgets',
    'updates',
    'replaces',
] as const;

export type RelationType = typeof RELATION_TYPES[number];

// ── Structured fact with confidence & versioning ─────

export type FactStatus = 'active' | 'superseded';

export interface Fact {
    content: string;
    /** Belief strength 0–1. Auto-calculated from sources + recency. */
    confidence: number;
    /** How many times this fact has been independently stated/confirmed. */
    sources: number;
    /** When first recorded. */
    firstSeen: number;
    /** When last confirmed or reinforced. */
    lastConfirmed: number;
    /** Lifecycle status: 'active' = current belief, 'superseded' = replaced by newer info.
     *  Superseded facts are retained for learning history, not deleted. */
    status: FactStatus;
    /** Content of the fact that replaced this one (only set when superseded). */
    supersededBy?: string;
    /** When this fact was superseded. */
    supersededAt?: number;
}

export interface Entity {
    name: string;
    type: EntityType;
    facts: Fact[];
    lastSeen: number;
    accessCount: number;
    /** Multi-dimensional tags for scoped search (e.g. { project: "forkscout", scope: "universal" }). */
    tags?: Record<string, string>;
}

export interface Relation {
    from: string;
    to: string;
    type: RelationType;
    /** Importance / reliability score 0–1. Grows with evidence. */
    weight: number;
    /** How many times this relation has been independently stated. */
    evidenceCount: number;
    /** When last confirmed or validated. */
    lastValidated: number;
    createdAt: number;
}

export interface Exchange {
    id: string;
    user: string;
    assistant: string;
    timestamp: number;
    sessionId: string;
    /** 0–1 significance score. Higher = more impactful conversation. */
    importance?: number;
    /** Multi-dimensional tags for scoped search (e.g. { project: "forkscout" }). */
    tags?: Record<string, string>;
}

export type TaskStatus = 'running' | 'paused' | 'completed' | 'aborted';

export interface ActiveTask {
    id: string;
    title: string;
    goal: string;
    status: TaskStatus;
    startedAt: number;
    lastStepAt: number;
    /** 0–1 attention weight. Higher = work on this first. */
    priority?: number;
    /** 0–1 long-term value. Higher = matters more in the big picture. */
    importance?: number;
    budgetRemaining?: number;
    successCondition?: string;
    stopReason?: string;
}

export const TASK_MAX_DURATION_MS = 2 * 60 * 60 * 1000;

export interface MemoryData {
    version: 7;
    entities: Entity[];
    relations: Relation[];
    exchanges: Exchange[];
    activeTasks: ActiveTask[];
}

/** V6 shapes for migration (no tags field on entities/exchanges). */
export interface LegacyMemoryDataV6 {
    version: 6;
    entities: Array<{ name: string; type: EntityType; facts: Fact[]; lastSeen: number; accessCount: number }>;
    relations: Relation[];
    exchanges: Array<{ id: string; user: string; assistant: string; timestamp: number; sessionId: string; importance?: number }>;
    activeTasks: ActiveTask[];
}

/** V5 shapes for migration (facts without status field) */
export interface LegacyMemoryDataV5 {
    version: 5;
    entities: Array<{ name: string; type: EntityType; facts: Array<{ content: string; confidence: number; sources: number; firstSeen: number; lastConfirmed: number }>; lastSeen: number; accessCount: number }>;
    relations: Relation[];
    exchanges: Exchange[];
    activeTasks: ActiveTask[];
}

/** V4 legacy shapes for migration */
export interface LegacyMemoryDataV4 {
    version: 4;
    entities: Array<{ name: string; type: EntityType; facts: string[]; lastSeen: number; accessCount: number }>;
    relations: Array<{ from: string; to: string; type: RelationType; createdAt: number }>;
    exchanges: Array<{ id: string; user: string; assistant: string; timestamp: number; sessionId: string }>;
    activeTasks: ActiveTask[];
}

export interface SearchResult {
    content: string;
    source: 'graph' | 'exchange';
    relevance: number;
}

export const SELF_ENTITY_NAME = process.env.SELF_ENTITY_NAME || 'Forkscout Agent';

// ── Working memory (session-scoped, not persisted to disk) ───────────────────

/** A single event in the agent's short-term context window. */
export interface WorkingMemoryEvent {
    /** What kind of event this is. */
    type: 'action' | 'observation' | 'decision' | 'error' | 'fact';
    content: string;
    timestamp: number;
    sessionId: string;
}

// ── Knowledge gaps (volatile facts that may be outdated) ─────────────────────

/**
 * A fact that is known to be volatile (port numbers, versions, file paths, env vars)
 * and has not been verified recently. Surfaced by getKnowledgeGaps().
 */
export interface KnowledgeGap {
    entityName: string;
    factContent: string;
    /** Always 'volatile' — only volatile facts produce gaps. */
    volatility: 'volatile';
    /** Timestamp of last confirmation (ms since epoch). */
    lastVerified: number;
    /** Human hint on how to re-verify (e.g. "Check package.json for version"). */
    verificationHint: string;
}

