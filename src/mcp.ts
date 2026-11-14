// MCP at POST /mcp: JSON-RPC 2.0 over plain JSON responses, speaking both
// protocol eras the suite accepts. The modern era (2026-07-28) negotiates
// through server/discover with no handshake and no session; the legacy era
// negotiates through initialize + notifications/initialized. Six tools,
// named as github-mcp-server names them, share the store with REST, so an
// object created over MCP is the same object over REST.
//
// Error discipline: an unknown tool is JSON-RPC -32602, a body that is not
// JSON is HTTP 400 with -32700, a tool call missing its required arguments
// answers isError, and authentication is decided before any method runs
// (the server layer 401s first).

import { issueJson, pullJson, repoJson, type ForgeStore, type Repo } from './store.ts';
import { jsonReply, type Reply, type RequestCtx } from './ctx.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tool list, built once: two tools/list answers must be byte-identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'The repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function missingArg(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  return value === undefined || value === null || value === '';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

type ToolHandler = (store: ForgeStore, args: Record<string, unknown>) => Record<string, unknown>;

function repoArg(store: ForgeStore, args: Record<string, unknown>): Repo | Record<string, unknown> {
  const repo = store.getRepo(asString(args.owner), asString(args.repo));
  return repo ?? toolError(`Repository ${asString(args.owner)}/${asString(args.repo)} was not found`);
}

function isToolError(value: Repo | Record<string, unknown>): value is Record<string, unknown> {
  return !('refs' in value);
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  create_repo: (store, args) => {
    if (missingArg(args, 'name')) return toolError('create_repo requires a name');
    const name = asString(args.name);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return toolError(`"${name}" is not a valid repository name`);
    if (store.repoExists(name)) return toolError(`name already exists on this account`);
    const repo = store.createRepo(name, args.private === true, asString(args.description));
    if (!repo) return toolError('name already exists on this account');
    return toolResult(repoJson(repo));
  },
  get_repo: (store, args) => {
    if (missingArg(args, 'owner') || missingArg(args, 'repo')) return toolError('get_repo requires owner and repo');
    const repo = repoArg(store, args);
    if (isToolError(repo)) return repo;
    return toolResult(repoJson(repo));
  },
  create_issue: (store, args) => {
    if (missingArg(args, 'owner') || missingArg(args, 'repo') || missingArg(args, 'title')) {
      return toolError('create_issue requires owner, repo and title');
    }
    const repo = repoArg(store, args);
    if (isToolError(repo)) return repo;
    const result = store.createIssue(repo, asString(args.title), asString(args.body), []);
    if ('error' in result) return toolError(result.error);
    return toolResult(issueJson(repo, result.issue));
  },
  list_issues: (store, args) => {
    if (missingArg(args, 'owner') || missingArg(args, 'repo')) return toolError('list_issues requires owner and repo');
    const repo = repoArg(store, args);
    if (isToolError(repo)) return repo;
    const state = asString(args.state) || 'open';
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    list.sort((a, b) => a.number - b.number);
    return toolResult(list.map((i) => issueJson(repo, i)));
  },
  create_pull_request: (store, args) => {
    if (missingArg(args, 'owner') || missingArg(args, 'repo') || missingArg(args, 'title') || missingArg(args, 'head') || missingArg(args, 'base')) {
      return toolError('create_pull_request requires owner, repo, title, head and base');
    }
    const repo = repoArg(store, args);
    if (isToolError(repo)) return repo;
    const result = store.createPull(repo, asString(args.title), asString(args.body), asString(args.head), asString(args.base));
    if ('error' in result) return toolError(result.error);
    return toolResult(pullJson(store, repo, result.pull));
  },
  merge_pull_request: (store, args) => {
    if (missingArg(args, 'owner') || missingArg(args, 'repo') || missingArg(args, 'pull_number')) {
      return toolError('merge_pull_request requires owner, repo and pull_number');
    }
    const repo = repoArg(store, args);
    if (isToolError(repo)) return repo;
    const number = asNumber(args.pull_number);
    if (number === null) return toolError('pull_number must be an integer');
    const pull = repo.pulls.get(number);
    if (!pull) return toolError(`Pull request #${number} was not found`);
    const result = store.mergePull(repo, pull, 'squash');
    if ('conflict' in result) return toolError(`Merge conflict in ${result.conflict}`);
    if ('error' in result) return toolError(result.error);
    return toolResult(pullJson(store, repo, pull));
  },
};

function rpcResult(id: unknown, result: unknown): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): Reply {
  return jsonReply(status, { jsonrpc: '2.0', id, error: { code, message } });
}

export function handleMcp(ctx: RequestCtx): Reply {
  if (ctx.method !== 'POST') {
    return jsonReply(405, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'MCP requires POST' } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return rpcError(null, PARSE_ERROR, 'Parse error: the body is not valid JSON', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object');
  }
  const request = parsed as Record<string, unknown>;
  const hasId = 'id' in request;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params) ? (request.params as Record<string, unknown>) : {};

  // Notifications carry no id and earn no JSON-RPC answer.
  if (!hasId) {
    return { status: 202, body: '', contentType: 'application/json; charset=utf-8' };
  }

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'notifications/initialized') {
    return rpcResult(id, {});
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    let outcome: Record<string, unknown>;
    try {
      outcome = handler(ctx.store, args);
    } catch (err) {
      outcome = toolError((err as Error).message);
    }
    return rpcResult(id, outcome);
  }

  return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
}
