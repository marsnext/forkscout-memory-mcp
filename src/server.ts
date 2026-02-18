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

const PORT = parseInt(process.env.MEMORY_PORT || '3211', 10);
const HOST = process.env.MEMORY_HOST || '0.0.0.0';
const STORAGE_DIR = process.env.MEMORY_STORAGE || resolve(process.cwd(), '.forkscout');
const OWNER = process.env.MEMORY_OWNER || 'Admin';

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

    // ── HTTP server ──────────────────────────────────
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
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
                activeTasks: store.tasks.runningCount,
            }));
            return;
        }

        // MCP endpoint — stateless: fresh transport per request
        if (url.startsWith('/mcp')) {
            try {
                const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                const mcp = createMcpServer(store);
                await mcp.connect(transport);

                let parsedBody: unknown;
                if (req.method === 'POST') {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                    parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                }
                await transport.handleRequest(req, res, parsedBody);
                await mcp.close();
            } catch (err) {
                console.error('MCP error:', err);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'MCP server error' }));
                }
            }
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found. Use /mcp or /health.' }));
    });

    server.listen(PORT, HOST, () => {
        console.log(`\n🧠 Forkscout Memory MCP Server`);
        console.log(`   MCP:      http://${HOST}:${PORT}/mcp`);
        console.log(`   Health:   http://${HOST}:${PORT}/health`);
        console.log(`   Storage:  ${STORAGE_DIR}/memory.json`);
        console.log(`   Entities: ${store.entityCount}, Relations: ${store.relationCount}, Exchanges: ${store.exchangeCount}`);
        console.log(`\n   VS Code:  "mcp": { "servers": { "forkscout-memory": { "type": "http", "url": "http://localhost:${PORT}/mcp" } } }\n`);
    });

    // ── Graceful shutdown ────────────────────────────
    const shutdown = async () => {
        console.log('\n🧠 Flushing memory...');
        clearInterval(flushInterval);
        await store.flush();
        server.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
