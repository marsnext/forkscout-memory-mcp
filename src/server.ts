#!/usr/bin/env node
/**
 * Forkscout Memory MCP Server — Standalone
 *
 * Lightweight, independent memory service. No agent, no LLM, no Playwright.
 * Shares the same memory.json file with the main Forkscout agent.
 *
 * Usage:
 *   npx tsx src/server.ts                      # dev mode
 *   node dist/server.js                        # production (after build)
 *   MEMORY_PORT=5000 node dist/server.js       # custom port
 *
 * Docker:
 *   docker compose up -d memory
 *
 * Connect from VS Code:
 *   "mcp": { "servers": { "forkscout-memory": { "type": "http", "url": "http://localhost:3211/mcp" } } }
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { resolve } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MemoryStore } from './store.js';
import { registerTools } from './tools.js';
import { renderVisualizerHtml } from './visualizer.js';

const PORT = parseInt(process.env.MEMORY_PORT || '3211', 10);
const HOST = process.env.MEMORY_HOST || '0.0.0.0';
const STORAGE_DIR = process.env.MEMORY_STORAGE || resolve(process.cwd(), '.forkscout');
const OWNER = process.env.MEMORY_OWNER || 'Admin';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

/** Full consolidation interval: default 24 hours (light consolidation runs on every flush). */
const CONSOLIDATION_INTERVAL_MS = parseInt(process.env.CONSOLIDATION_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);
/** Whether to verify file entities against the filesystem. Disable in Docker. */
const VERIFY_FILES = process.env.VERIFY_FILES !== 'false';

function createMcpServer(store: MemoryStore) {
    const mcp = new McpServer({ name: 'forkscout-memory', version: '1.0.0' });
    registerTools(mcp, store);
    return mcp;
}

async function main() {
    // ── Init memory store ────────────────────────────
    const store = new MemoryStore(resolve(STORAGE_DIR, 'memory.json'), OWNER);
    await store.init();

    // ── Periodic flush ───────────────────────────────
    const flushInterval = setInterval(() => store.flush(), 30_000);

    // ── Periodic consolidation ───────────────────────
    let consolidationRunning = false;
    const runConsolidation = async () => {
        if (consolidationRunning) return;
        consolidationRunning = true;
        try {
            console.log('[Consolidator] Starting full consolidation (pruning + verification)...');

            // 1. Consolidate (confidence refresh, pruning, orphan cleanup, duplicate detection)
            const report = await store.consolidate();
            const lines = [
                `  Confidence refreshed: ${report.factsRefreshed}`,
                `  Facts pruned: ${report.factsPruned}`,
                `  Empty entities removed: ${report.entitiesRemoved}`,
                `  Orphan relations removed: ${report.relationsRemoved}`,
            ];
            if (report.duplicatesFound.length > 0) {
                lines.push(`  Potential duplicates: ${report.duplicatesFound.length}`);
            }

            // 2. Verify file entities (if running with fs access)
            if (VERIFY_FILES) {
                const vResult = await store.verifyFileEntities();
                lines.push(`  Files verified: ${vResult.filesChecked}, missing: ${vResult.filesMissing}`);
            }

            // 3. Count stale entities (for logging)
            const stale = store.getStaleEntities({ maxAgeDays: 30 });
            lines.push(`  Stale entities (>30d): ${stale.length}`);

            await store.flush();
            console.log(`[Consolidator] Done:\n${lines.join('\n')}`);
        } catch (err) {
            console.error('[Consolidator] Error:', err instanceof Error ? err.message : String(err));
        } finally {
            consolidationRunning = false;
        }
    };

    // First run after 60s (let the server settle), then every CONSOLIDATION_INTERVAL_MS
    const consolidationDelay = setTimeout(() => {
        runConsolidation();
    }, 60_000);
    const consolidationInterval = setInterval(runConsolidation, CONSOLIDATION_INTERVAL_MS);
    const intervalHours = Math.round(CONSOLIDATION_INTERVAL_MS / 3600000);
    console.log(`🔧 Consolidation: confidence refresh on every flush (5min throttle), full pruning every ${intervalHours}h, file verification: ${VERIFY_FILES ? 'on' : 'off'}`);

    // ── HTTP server ──────────────────────────────────
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');
        res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const url = req.url || '';

        // Health check
        if (url === '/health' || url === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                entities: store.entityCount,
                relations: store.relationCount,
                exchanges: store.exchangeCount,
                exchangesHot: store.hotExchangeCount,
                exchangesArchived: store.archiveExchangeCount,
                activeTasks: store.tasks.runningCount,
                consolidation: {
                    fullIntervalHours: Math.round(CONSOLIDATION_INTERVAL_MS / 3600000),
                    confidenceRefresh: 'on-flush (5min throttle)',
                    verifyFiles: VERIFY_FILES,
                },
            }));
            return;
        }

        if (url === '/api/memory') {
            try {
                const snapshot = await store.getVisualizationSnapshot();
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(snapshot));
            } catch (err) {
                console.error('Visualization API error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to build memory snapshot.' }));
            }
            return;
        }

        if (url === '/visualizer') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderVisualizerHtml());
            return;
        }

        // MCP endpoint — stateless: fresh transport per request
        if (url.startsWith('/mcp')) {
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            const mcp = createMcpServer(store);
            try {
                await mcp.connect(transport);

                let parsedBody: unknown;
                if (req.method === 'POST') {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                    parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                }
                await transport.handleRequest(req, res, parsedBody);
            } catch (err) {
                console.error('MCP error:', err);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'MCP server error' }));
                }
            } finally {
                await mcp.close();
            }
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found. Use /mcp, /health, /api/memory, or /visualizer.' }));
    });

    server.listen(PORT, HOST, () => {
        console.log(`\n🧠 Forkscout Memory MCP Server`);
        console.log(`   MCP:      http://${HOST}:${PORT}/mcp`);
        console.log(`   Health:   http://${HOST}:${PORT}/health`);
        console.log(`   Storage:  ${STORAGE_DIR}/memory.json`);
        console.log(`   Entities: ${store.entityCount}, Relations: ${store.relationCount}, Exchanges: ${store.hotExchangeCount} hot + ${store.archiveExchangeCount} archived`);
        console.log(`\n   VS Code:  "mcp": { "servers": { "forkscout-memory": { "type": "http", "url": "http://localhost:${PORT}/mcp" } } }\n`);
    });

    // ── Graceful shutdown ────────────────────────────
    const shutdown = async () => {
        console.log('\n🧠 Flushing memory...');
        clearInterval(flushInterval);
        clearTimeout(consolidationDelay);
        clearInterval(consolidationInterval);
        await store.flush();
        server.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
