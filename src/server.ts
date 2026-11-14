// The HTTP server: one listener, keep-alive, routing to the four surfaces
// (git smart HTTP, REST v3, GraphQL, MCP), and the single bearer-token rule
// the whole forge enforces. Bodies are read fully before dispatch — the
// largest legitimate body is a pushed packfile, a few hundred kilobytes —
// and every handler runs inside a try/catch so one bad request can never
// take the server down mid-trial.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResponse } from './githttp.ts';
import { errorReply, nextRequestId, type Reply, type RequestCtx } from './ctx.ts';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface ForgeServerOptions {
  /** The expected bearer token; '' accepts any non-empty bearer token. */
  readonly token?: string;
}

export interface ForgeServer {
  readonly server: Server;
  readonly store: ForgeStore;
}

function authorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  return expected === '' ? true : presented === expected;
}

function gitResponseToReply(response: GitResponse): Reply {
  return { status: response.status, body: response.body, contentType: response.contentType };
}

function writeReply(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string> = {
    'X-GitHub-Request-Id': requestId,
    ...(reply.headers ?? {}),
  };
  if (reply.status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const body = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
  headers['Content-Type'] = reply.contentType;
  headers['Content-Length'] = String(body.length);
  res.writeHead(reply.status, headers);
  res.end(body);
}

function splitPath(pathname: string): string[] | null {
  const raw = pathname.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (const part of raw) {
    try {
      out.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return out;
}

export function createForgeServer(options: ForgeServerOptions = {}): ForgeServer {
  const store = new ForgeStore();
  const expectedToken = options.token ?? '';

  const server = createServer((req, res) => {
    const requestId = nextRequestId();
    const chunks: Buffer[] = [];
    let bodySize = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        if (tooLarge) {
          writeReply(res, errorReply(413, 'Request body too large'), requestId);
          return;
        }
        const body = Buffer.concat(chunks);
        let url: URL;
        try {
          url = new URL(req.url ?? '/', 'http://forge');
        } catch {
          writeReply(res, errorReply(400, 'Bad request URL'), requestId);
          return;
        }
        const segments = splitPath(url.pathname);
        if (segments === null) {
          writeReply(res, errorReply(400, 'Bad request path'), requestId);
          return;
        }
        const method = req.method ?? 'GET';
        const ctx: RequestCtx = {
          store,
          method,
          pathname: url.pathname,
          segments,
          query: url.searchParams,
          headers: req.headers,
          body,
          requestId,
          host: req.headers.host ?? '127.0.0.1',
        };

        // The health probe answers without authentication.
        if (segments.length === 1 && segments[0] === 'healthz') {
          writeReply(res, { status: 200, body: '{"status":"ok"}', contentType: 'application/json; charset=utf-8' }, requestId);
          return;
        }

        const isApi = segments[0] === 'api' && (segments[1] === 'v3' || segments[1] === 'graphql');
        const isMcp = segments.length === 1 && segments[0] === 'mcp';
        const isGit = segments.length >= 2 && segments[1].endsWith('.git');

        if (isApi || isMcp || isGit) {
          if (!authorized(req, expectedToken)) {
            writeReply(res, errorReply(401, 'Requires authentication'), requestId);
            return;
          }
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          writeReply(res, handleRest(ctx), requestId);
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          writeReply(res, handleGraphQL(ctx), requestId);
          return;
        }
        if (isMcp) {
          writeReply(res, handleMcp(ctx), requestId);
          return;
        }
        if (isGit) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -'.git'.length);
          const gitProtocol = req.headers['git-protocol'];
          if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            writeReply(
              res,
              gitResponseToReply(handleInfoRefs(store, owner, repoName, service, gitProtocol)),
              requestId,
            );
            return;
          }
          if (segments.length === 3 && segments[2] === 'git-upload-pack' && method === 'POST') {
            writeReply(res, gitResponseToReply(handleUploadPack(store, owner, repoName, body, gitProtocol)), requestId);
            return;
          }
          if (segments.length === 3 && segments[2] === 'git-receive-pack' && method === 'POST') {
            writeReply(res, gitResponseToReply(handleReceivePack(store, owner, repoName, body)), requestId);
            return;
          }
          writeReply(res, errorReply(404, 'Not Found'), requestId);
          return;
        }

        writeReply(res, errorReply(404, 'Not Found'), requestId);
      } catch (err) {
        try {
          writeReply(res, errorReply(500, `Internal error: ${(err as Error).message}`), requestId);
        } catch {
          try {
            res.destroy();
          } catch {
            // nothing left to do
          }
        }
      }
    });
    req.on('error', () => {
      try {
        res.destroy();
      } catch {
        // the socket is already gone
      }
    });
  });

  return { server, store };
}
