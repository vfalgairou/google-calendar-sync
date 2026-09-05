import { createServer, type Server } from 'node:http';
import type { SyncEngine } from './engine.js';
import { sanitizedError } from './google.js';

export function createSyncServer(engine: SyncEngine): Server {
  let active = false;
  // Authentication belongs to Cloud Run IAM. This listener must not be published
  // unauthenticated on a dedicated host; Compose runs the non-HTTP worker instead.
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === '/healthz') { response.end('{"status":"ok"}'); return; }
    if (request.method !== 'POST' || request.url !== '/sync') { response.writeHead(404).end('{"error":"not_found"}'); return; }
    if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? '0') > 0) { response.writeHead(400).end('{"error":"body_not_allowed"}'); return; }
    if (active) { response.writeHead(200).end('{"status":"busy"}'); return; }
    active = true;
    try {
      const { actions: _, ...report } = await engine.run();
      response.end(JSON.stringify(report));
    } catch (e) { response.writeHead(503).end(JSON.stringify({ error: sanitizedError(e).code })); }
    finally { active = false; }
  });
  server.requestTimeout = 90_000;
  return server;
}
