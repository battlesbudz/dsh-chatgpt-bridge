/**
 * Streamable HTTP transport for the MCP server, hosted on the bridge's own
 * node:http server. STATE-FUL mode, one McpServer instance per MCP session
 * (the SDK's Protocol allows exactly one transport per instance). Each
 * session's tools call into the shared Bridge, so per-session server
 * instances are thin and cheap. Loopback-only by default; every request is
 * authenticated against the bearer token when authMode is 'token'.
 *
 * Endpoints (MCP Streamable HTTP):
 *   POST /mcp  JSON-RPC messages (initialize first, then tools/list, tools/call...)
 *   GET  /mcp  SSE stream for server notifications (requires mcp-session-id)
 *   DELETE /mcp  close the MCP session
 */
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length)
        return false;
    return timingSafeEqual(left, right);
}
/** Read and parse a JSON request body (empty bodies yield undefined). */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.trim() === '')
                return resolve(undefined);
            try {
                resolve(JSON.parse(raw));
            }
            catch {
                resolve(undefined);
            }
        });
        req.on('error', reject);
    });
}
function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Last-Event-ID');
}
function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
}
export function startHttpServer(createSessionServer, options, log) {
    return new Promise((resolve, reject) => {
        const authorize = (req) => {
            if (options.authMode === 'none')
                return true;
            const header = req.headers.authorization;
            if (header === undefined)
                return false;
            const match = /^Bearer\s+(.+)$/i.exec(header);
            return match !== null && safeEqual(match[1], options.authToken);
        };
        /** One MCP session: its transport plus the per-session server instance. */
        const sessions = new Map();
        const httpServer = createServer(async (req, res) => {
            try {
                setCors(res);
                if (req.method === 'OPTIONS') {
                    res.statusCode = 204;
                    res.end();
                    return;
                }
                const url = req.url ?? '/';
                const path = url.split('?')[0];
                if (path !== '/mcp') {
                    sendJson(res, 404, { error: 'not-found' });
                    return;
                }
                if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
                    sendJson(res, 405, { error: 'method-not-allowed' });
                    return;
                }
                if (!authorize(req)) {
                    log.warn('MCP request rejected: missing or invalid bearer token');
                    sendJson(res, 401, { error: 'unauthorized' });
                    return;
                }
                const sessionId = req.headers['mcp-session-id'];
                const existing = typeof sessionId === 'string' && sessionId !== '' ? sessions.get(sessionId) : undefined;
                if (existing !== undefined) {
                    const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
                    await existing.transport.handleRequest(req, res, parsedBody);
                    return;
                }
                if (sessionId !== undefined || req.method !== 'POST') {
                    // Unknown session id, or GET/DELETE without a session: per spec the
                    // session must exist before streaming or closing.
                    sendJson(res, sessionId !== undefined ? 404 : 400, { error: 'session-not-found' });
                    return;
                }
                // Fresh MCP session: one transport + one server instance.
                let entry;
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (id) => {
                        if (entry !== undefined)
                            sessions.set(id, entry);
                    },
                });
                entry = { transport, server: createSessionServer() };
                await entry.server.connect(transport);
                transport.onclose = () => {
                    const id = transport.sessionId;
                    if (id !== undefined)
                        sessions.delete(id);
                    void entry?.server.close().catch(() => { });
                };
                const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
                await transport.handleRequest(req, res, parsedBody);
            }
            catch (error) {
                log.error(`MCP HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent)
                    sendJson(res, 500, { error: 'internal-error' });
                else
                    res.destroy();
            }
        });
        httpServer.once('error', reject);
        httpServer.listen(options.port, options.host, () => {
            const address = httpServer.address();
            const port = address.port;
            log.info(`MCP Streamable HTTP server listening on http://${options.host}:${port}/mcp (auth: ${options.authMode})`);
            resolve({
                port,
                url: `http://${options.host}:${port}/mcp`,
                close: async () => {
                    for (const entry of [...sessions.values()]) {
                        try {
                            await entry.transport.close();
                        }
                        catch {
                            // best-effort
                        }
                        try {
                            await entry.server.close();
                        }
                        catch {
                            // best-effort
                        }
                    }
                    sessions.clear();
                    await new Promise((done) => httpServer.close(() => done()));
                },
            });
        });
    });
}
