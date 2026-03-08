/**
 * EmbeddingManager — local vector embeddings via @xenova/transformers.
 *
 * Model: Xenova/all-MiniLM-L6-v2  (22 MB quantized, 384-dim, MTEB-class quality)
 * Approach:
 *   – Model loads lazily on first embed request (non-blocking startup)
 *   – Pre-computed embeddings stored in memory Map<entityKey, Float32Array>
 *   – Persisted to <storagePath>/embeddings.json on flush
 *   – If model unavailable (offline / download fails), all methods return null
 *     gracefully — callers fall back to BM25-only search automatically
 *
 * Cache: TRANSFORMERS_CACHE env var controls where models are downloaded.
 *        Defaults to /tmp/.transformers-cache so it persists across restarts
 *        when the model dir is mounted as a volume.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

// ── Types compatible with both @xenova/transformers v2 and v3 ────────────────
type PipelineFn = (text: string, options?: Record<string, unknown>) => Promise<unknown>;

// ── Cosine similarity (pure, no deps) ───────────────────────────────────────
export function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0, n2A = 0, n2B = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        n2A += a[i] * a[i];
        n2B += b[i] * b[i];
    }
    if (n2A === 0 || n2B === 0) return 0;
    return dot / (Math.sqrt(n2A) * Math.sqrt(n2B));
}

// ── EmbeddingManager ────────────────────────────────────────────────────────
export class EmbeddingManager {
    private static readonly MODEL = 'Xenova/all-MiniLM-L6-v2';
    private static readonly DIMS = 384;

    private pipeline: PipelineFn | null = null;
    private loadingPromise: Promise<void> | null = null;
    private modelReady = false;
    private modelFailed = false;

    private map = new Map<string, Float32Array>();
    private storagePath = '';
    private dirty = false;

    // ── Init ─────────────────────────────────────────
    async init(storagePath: string): Promise<void> {
        this.storagePath = storagePath;
        await this._loadFromDisk();
        // Warm up in background — don't block server startup
        this._ensureModel().then(() => {
            if (this.modelReady) {
                console.log(`🔢 Embeddings ready (${EmbeddingManager.MODEL}, ${this.map.size} cached)`);
            }
        }).catch(() => { /* already logged in _ensureModel */ });
    }

    // ── Encode a string → Float32Array (null if model unavailable) ───────────
    async encode(text: string): Promise<Float32Array | null> {
        await this._ensureModel();
        if (!this.pipeline || this.modelFailed) return null;
        try {
            const result = await this.pipeline(text, { pooling: 'mean', normalize: true });
            // @xenova/transformers v2 returns Tensor with .data property
            const data = (result as { data: Float32Array }).data;
            return new Float32Array(data);
        } catch (err) {
            console.warn('[Embeddings] encode failed:', (err as Error).message);
            return null;
        }
    }

    // ── Upsert an embedding for a key ───────────────────────────────────────
    set(key: string, vec: Float32Array): void {
        this.map.set(key, vec);
        this.dirty = true;
    }

    get(key: string): Float32Array | undefined {
        return this.map.get(key);
    }

    delete(key: string): void {
        if (this.map.delete(key)) this.dirty = true;
    }

    has(key: string): boolean { return this.map.has(key); }
    entries(): IterableIterator<[string, Float32Array]> { return this.map.entries(); }
    get size(): number { return this.map.size; }
    get ready(): boolean { return this.modelReady; }

    // ── Persist / load ───────────────────────────────────────────────────────
    async persist(): Promise<void> {
        if (!this.dirty || !this.storagePath) return;
        try {
            await mkdir(dirname(this.storagePath), { recursive: true });
            const obj: Record<string, number[]> = {};
            for (const [k, v] of this.map) obj[k] = Array.from(v);
            const tmp = this.storagePath + '.tmp';
            await writeFile(tmp, JSON.stringify(obj), 'utf-8');
            const { rename } = await import('fs/promises');
            await rename(tmp, this.storagePath);
            this.dirty = false;
        } catch (err) {
            console.warn('[Embeddings] persist failed:', (err as Error).message);
        }
    }

    private async _loadFromDisk(): Promise<void> {
        try {
            const raw = await readFile(this.storagePath, 'utf-8');
            const obj = JSON.parse(raw) as Record<string, number[]>;
            let loaded = 0;
            for (const [k, v] of Object.entries(obj)) {
                if (Array.isArray(v) && v.length === EmbeddingManager.DIMS) {
                    this.map.set(k, new Float32Array(v));
                    loaded++;
                }
            }
            if (loaded > 0) console.log(`🔢 Loaded ${loaded} embeddings from disk`);
        } catch { /* no file yet — fresh start */ }
    }

    private async _ensureModel(): Promise<void> {
        if (this.modelReady || this.modelFailed) return;
        if (this.loadingPromise) { await this.loadingPromise; return; }

        this.loadingPromise = (async () => {
            try {
                // Dynamic import so server starts immediately; model downloads in BG
                const { pipeline, env } = await import('@xenova/transformers') as any;
                // Set cache dir from env var (defaults to inside data volume on Docker)
                const cacheDir = process.env.TRANSFORMERS_CACHE || '/tmp/.transformers-cache';
                env.cacheDir = cacheDir;
                env.allowLocalModels = true;
                env.allowRemoteModels = true;

                console.log(`🔢 Loading embedding model: ${EmbeddingManager.MODEL}`);
                this.pipeline = await pipeline('feature-extraction', EmbeddingManager.MODEL, {
                    quantized: true,
                });
                this.modelReady = true;

                // Backfill any entities that don't have embeddings yet
                // (e.g. loaded from disk before model was available)
                // This is done lazily — callers can trigger via embedEntityAsync
            } catch (err) {
                this.modelFailed = true;
                console.warn(`[Embeddings] Model unavailable (BM25 fallback active): ${(err as Error).message}`);
            }
        })();
        await this.loadingPromise;
    }
}
