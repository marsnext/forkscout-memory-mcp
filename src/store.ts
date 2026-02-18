/**
 * Memory Store — single JSON persistence for entities, relations, exchanges, and tasks.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { Entity, EntityType, Exchange, MemoryData, Relation, RelationType, SearchResult } from './types.js';
import { SELF_ENTITY_NAME } from './types.js';
import { TaskManager } from './tasks.js';

export class MemoryStore {
    private entities = new Map<string, Entity>();
    private relations: Relation[] = [];
    private exchanges: Exchange[] = [];
    private dirty = false;
    private filePath: string;
    private ownerName: string;
    readonly tasks = new TaskManager();

    constructor(filePath: string, ownerName = 'Admin') {
        this.filePath = filePath;
        this.ownerName = ownerName;
    }

    async init(): Promise<void> {
        try {
            const raw = await readFile(this.filePath, 'utf-8');
            const data = JSON.parse(raw) as MemoryData;
            for (const e of data.entities) this.entities.set(this.key(e.name), e);
            this.relations = data.relations || [];
            this.exchanges = data.exchanges || [];
            this.tasks.load((data as any).activeTasks || []);
        } catch { /* start fresh */ }
        this.ensureSelfEntity();
        console.log(`🧠 Memory: ${this.entities.size} entities, ${this.relations.length} relations, ${this.exchanges.length} exchanges`);
    }

    async flush(): Promise<void> {
        if (!this.dirty && !this.tasks.isDirty()) return;
        try {
            await mkdir(dirname(this.filePath), { recursive: true });
            const data: MemoryData = {
                version: 4,
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

    addEntity(name: string, type: EntityType, facts: string[]): Entity {
        const k = this.key(name);
        const existing = this.entities.get(k);
        if (existing) {
            for (const f of facts) {
                if (!existing.facts.some(ef => ef.toLowerCase() === f.toLowerCase())) existing.facts.push(f);
            }
            existing.lastSeen = Date.now();
            existing.accessCount++;
            this.dirty = true;
            return existing;
        }
        const entity: Entity = { name, type, facts, lastSeen: Date.now(), accessCount: 1 };
        this.entities.set(k, entity);
        this.dirty = true;
        return entity;
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

    // ── Relations ────────────────────────────────────

    addRelation(from: string, type: RelationType, to: string): Relation {
        const existing = this.relations.find(r =>
            this.key(r.from) === this.key(from) && this.key(r.to) === this.key(to) && r.type === type);
        if (existing) return existing;
        const rel: Relation = { from, to, type, createdAt: Date.now() };
        this.relations.push(rel);
        this.dirty = true;
        return rel;
    }

    getAllRelations(): Relation[] { return this.relations; }

    // ── Exchanges ────────────────────────────────────

    addExchange(user: string, assistant: string, sessionId: string): Exchange {
        const ex: Exchange = {
            id: `ex_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            user: user.slice(0, 2000),
            assistant: assistant.slice(0, 2000),
            timestamp: Date.now(),
            sessionId,
        };
        this.exchanges.push(ex);
        this.dirty = true;
        return ex;
    }

    getExchanges(): Exchange[] { return this.exchanges; }

    // ── Search ───────────────────────────────────────

    searchEntities(query: string, limit = 5): Entity[] {
        const q = query.toLowerCase();
        const terms = q.split(/\s+/).filter(Boolean);
        const scored: Array<{ entity: Entity; score: number }> = [];
        for (const entity of this.entities.values()) {
            let score = 0;
            const nameL = entity.name.toLowerCase();
            if (nameL === q) score += 10;
            else if (nameL.includes(q)) score += 5;
            for (const t of terms) {
                if (nameL.includes(t)) score += 2;
                for (const f of entity.facts) { if (f.toLowerCase().includes(t)) score += 1; }
            }
            score += Math.min(entity.accessCount * 0.1, 1);
            if (score > 0) scored.push({ entity, score });
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.entity);
    }

    searchExchanges(query: string, limit = 5): Exchange[] {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const scored: Array<{ ex: Exchange; score: number }> = [];
        for (const ex of this.exchanges) {
            let score = 0;
            const text = `${ex.user} ${ex.assistant}`.toLowerCase();
            for (const t of terms) { if (text.includes(t)) score += 1; }
            if (score > 0) scored.push({ ex, score });
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.ex);
    }

    searchKnowledge(query: string, limit = 5): SearchResult[] {
        const results: SearchResult[] = [];
        for (const e of this.searchEntities(query, limit)) {
            results.push({ content: `${e.name} (${e.type}): ${e.facts.slice(0, 5).join('; ')}`, source: 'graph', relevance: 90 });
        }
        for (const ex of this.searchExchanges(query, limit)) {
            results.push({ content: `User: ${ex.user.slice(0, 200)} → Assistant: ${ex.assistant.slice(0, 200)}`, source: 'exchange', relevance: 70 });
        }
        return results.slice(0, limit);
    }

    // ── Self-entity ──────────────────────────────────

    getSelfEntity(): Entity {
        this.ensureSelfEntity();
        return this.entities.get(this.key(SELF_ENTITY_NAME))!;
    }

    addSelfObservation(content: string): void {
        const self = this.getSelfEntity();
        if (!self.facts.some(f => f.toLowerCase() === content.toLowerCase())) {
            self.facts.push(content);
            self.lastSeen = Date.now();
            this.dirty = true;
        }
    }

    // ── Stats ────────────────────────────────────────

    get entityCount(): number { return this.entities.size; }
    get relationCount(): number { return this.relations.length; }
    get exchangeCount(): number { return this.exchanges.length; }

    private key(name: string): string { return name.toLowerCase().trim(); }

    private ensureSelfEntity(): void {
        if (!this.entities.has(this.key(SELF_ENTITY_NAME))) {
            this.addEntity(SELF_ENTITY_NAME, 'agent-self', [
                `AI agent created by ${this.ownerName}`,
                'Capable of running commands, editing files, web search, and scheduling tasks',
            ]);
        }
    }
}
