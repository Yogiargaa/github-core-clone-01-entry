// The request context every handler receives, and the reply helpers that
// keep response shapes consistent: JSON bodies, the request-id header the
// suite requires on every reply, and absolute-URL pagination links.

import type { IncomingHttpHeaders } from 'node:http';
import type { ForgeStore } from './store.ts';

export interface RequestCtx {
  readonly store: ForgeStore;
  readonly method: string;
  readonly pathname: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly requestId: string;
  readonly host: string;
}

export interface Reply {
  readonly status: number;
  readonly body: string | Buffer;
  readonly contentType: string;
  readonly headers?: Record<string, string>;
}

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${Date.now().toString(36)}-${requestCounter}`;
}

export function jsonReply(status: number, value: unknown, extra?: Record<string, string>): Reply {
  return { status, body: JSON.stringify(value), contentType: 'application/json; charset=utf-8', headers: extra };
}

export function jsonTextReply(status: number, text: string, extra?: Record<string, string>): Reply {
  return { status, body: text, contentType: 'application/json; charset=utf-8', headers: extra };
}

export function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

/** Parse a request body as JSON: {} for an empty body, null when malformed. */
export function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return null;
  }
}

export interface PageParams {
  readonly perPage: number;
  readonly page: number;
}

export function pageParams(query: URLSearchParams): PageParams {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isInteger(perPageRaw) && perPageRaw > 0 ? Math.min(100, perPageRaw) : 30;
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

/**
 * Slice one page out of `items` and build the Link header GitHub sends:
 * absolute URLs, rel="next"/"prev"/"first"/"last" as applicable.
 */
export function paginate<T>(ctx: RequestCtx, items: readonly T[], params: PageParams): { page: T[]; link: string | null } {
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  const start = (params.page - 1) * params.perPage;
  const page = items.slice(start, start + params.perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(params.perPage));
    q.set('page', String(p));
    return `http://${ctx.host}${ctx.pathname}?${q.toString()}`;
  };
  if (params.page < totalPages) links.push(`<${urlFor(params.page + 1)}>; rel="next"`);
  if (params.page > 1) links.push(`<${urlFor(params.page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page, link: links.length > 0 ? links.join(', ') : null };
}
