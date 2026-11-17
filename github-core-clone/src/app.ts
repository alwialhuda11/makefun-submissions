// app.ts: the HTTP server wiring all surfaces (REST v3, git smart HTTP, GraphQL v4, MCP).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { newState, type State } from './store.ts';
import { handleRest, RestError, VIEWER, repoObject } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitInfoRefs, handleGitService } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

interface ParsedBody { text: string; json: unknown | null }

function parseBody(req: IncomingMessage): Promise<ParsedBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json: unknown | null = null;
      if (text.trim() !== '') {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      resolve({ text, json });
    });
    req.on('error', () => resolve({ text: '', json: null }));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const finalHeaders: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': 'req-' + Math.random().toString(36).slice(2, 10),
    ...headers,
  };
  res.writeHead(status, finalHeaders);
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, buf: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(buf.length),
    'x-github-request-id': 'req-' + Math.random().toString(36).slice(2, 10),
  });
  res.end(buf);
}

export function createApp(): Server {
  const state: State = newState();
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = decodeURIComponent(url.pathname);
      const method = req.method ?? 'GET';

      // health check
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const auth = req.headers.authorization ?? '';
      const authed = auth.startsWith('Bearer ') && auth.slice(7) === TOKEN;

      // --- git smart HTTP ---
      const gitMatch = /^\/api\/?[^/]*\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path) ?? /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
      if (gitMatch) {
        const owner = gitMatch[1], repoName = gitMatch[2], rest = gitMatch[3];
        const gitProtocol = req.headers['git-protocol'] as string | null;
        if (rest === 'info/refs') {
          const service = url.searchParams.get('service') ?? '';
          const r = handleGitInfoRefs(state, owner, repoName, service, gitProtocol);
          sendBuffer(res, r.status, r.contentType, r.body);
          return;
        }
        if (rest === 'git-upload-pack' || rest === 'git-receive-pack') {
          const { text } = await parseBody(req);
          const r = handleGitService(state, owner, repoName, rest, Buffer.from(text, 'utf8'), gitProtocol);
          sendBuffer(res, r.status, r.contentType, r.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // --- MCP ---
      if (path === '/mcp' || path.startsWith('/mcp')) {
        const { text } = await parseBody(req);
        const r = await handleMcp(state, Buffer.from(text, 'utf8'), authed);
        sendBuffer(res, r.status, r.contentType, r.body);
        return;
      }

      // --- GraphQL ---
      if (path === '/api/graphql' || path === '/graphql') {
        if (!authed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        const { json } = await parseBody(req);
        if (json === null || typeof json !== 'object') { sendJson(res, 400, { message: 'Bad Request' }); return; }
        const body = json as Record<string, unknown>;
        const result = executeGraphQL(state, {
          query: String(body.query ?? ''),
          variables: (body.variables as Record<string, unknown>) || {},
          authed,
        });
        sendJson(res, 200, result);
        return;
      }

      // --- REST v3 ---
      if (path.startsWith('/api/v3')) {
        if (!authed) {
          // some endpoints may be reachable without auth? All REST requires auth (401)
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const parsed = await parseBody(req);
        const isJsonCT = (req.headers['content-type'] ?? '').toLowerCase().includes('application/json');
        // malformed JSON body -> 400 (a body was sent with a JSON content-type but is not valid JSON)
        if (isJsonCT && parsed.text.trim() !== '' && parsed.json === null) {
          sendJson(res, 400, { message: 'Bad Request' });
          return;
        }
        const handled = handleRest(state, { method, path, query: url.searchParams, body: parsed.json, authed });
        // pagination Link header for /user/repos?per_page=
        if (path === '/api/v3/user/repos' && method === 'GET') {
          const perPage = Number(url.searchParams.get('per_page') ?? 30);
          const repos = [...state.repos.values()].filter((r) => r.owner === VIEWER);
          if (perPage > 0 && repos.length > perPage) {
            const page = Number(url.searchParams.get('page') ?? 1);
            const start = (page - 1) * perPage;
            const slice = repos.slice(start, start + perPage);
            const linkParts: string[] = [];
            const totalPages = Math.ceil(repos.length / perPage);
            for (let p = 1; p <= totalPages; p++) {
              if (p === page || p === page + 1) linkParts.push(`<${url.origin}${url.pathname}?per_page=${perPage}&page=${p}>; rel="${p === page + 1 ? 'next' : 'self'}"`);
            }
            const link = linkParts.join(', ');
            sendJson(res, 200, slice.map(repoObject), { link });
            return;
          }
        }
        sendJson(res, handled.status, handled.body);
        return;
      }

      // unknown route -> JSON 404
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof RestError) {
        sendJson(res, err.status, { message: err.message });
        return;
      }
      process.stderr.write('[entry] unhandled: ' + (err instanceof Error ? (err.stack || err.message) : String(err)) + '\n');
      sendJson(res, 500, { message: 'Internal Server Error' });
    }
  });
}

function isValidJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}
