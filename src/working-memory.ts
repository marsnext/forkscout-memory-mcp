/**
 * Working Memory — session-scoped, in-RAM context window.
 *
 * Stores the last N events per session (actions taken, decisions made,
 * observations noted, errors encountered). Never persisted to disk —
 * it resets when the server restarts, making it true "short-term" memory.
 *
 * Design goals:
 *   - Fast: O(1) push, O(1) get (slice from ring buffer)
 *   - Scoped: each session has its own independent window
 *   - Bounded: older events evicted automatically (window = 25)
 *   - Readable: human-facing summary for AI context injection
 */

import type { WorkingMemoryEvent } from './types.js';

export class WorkingMemoryManager {
    private readonly sessions = new Map<string, WorkingMemoryEvent[]>();
    private static readonly WINDOW = 25;

    /** Push a new event into a session's context window. Evicts oldest if full. */
    push(sessionId: string, type: WorkingMemoryEvent['type'], content: string): void {
        const events = this.sessions.get(sessionId) ?? [];
        events.push({ type, content, timestamp: Date.now(), sessionId });
        if (events.length > WorkingMemoryManager.WINDOW) events.shift();
        this.sessions.set(sessionId, events);
    }

    /** Get the N most recent events for a session. */
    get(sessionId: string, limit = 10): WorkingMemoryEvent[] {
        return (this.sessions.get(sessionId) ?? []).slice(-limit);
    }

    /** Clear working memory for a session (e.g. on session end). */
    clear(sessionId: string): void {
        this.sessions.delete(sessionId);
    }

    /**
     * Return a human-readable summary of recent events.
     * Format: [type|age] content
     */
    summary(sessionId: string, limit = 10): string {
        const events = this.get(sessionId, limit);
        if (events.length === 0) return 'Empty — no context pushed for this session yet.';
        return events.map(e => {
            const ageSec = Math.round((Date.now() - e.timestamp) / 1000);
            const ageStr = ageSec < 60 ? `${ageSec}s` : `${Math.round(ageSec / 60)}m`;
            return `[${e.type}|${ageStr} ago] ${e.content}`;
        }).join('\n');
    }

    /** Number of active sessions in memory. */
    activeSessions(): number {
        return this.sessions.size;
    }

    /** Serialize all sessions for persistence (flush to disk). */
    serializeSessions(): Record<string, WorkingMemoryEvent[]> {
        const result: Record<string, WorkingMemoryEvent[]> = {};
        for (const [sessionId, events] of this.sessions) {
            if (events.length > 0) result[sessionId] = events;
        }
        return result;
    }

    /** Restore sessions from persisted data (loaded on server restart). */
    restoreSessions(data: Record<string, WorkingMemoryEvent[]>): void {
        for (const [sessionId, events] of Object.entries(data)) {
            if (Array.isArray(events) && events.length > 0) {
                this.sessions.set(sessionId, events.slice(-WorkingMemoryManager.WINDOW));
            }
        }
    }
}
