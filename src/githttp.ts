// Git smart HTTP: the info/refs advertisements, the protocol-v2 ls-refs and
// fetch commands, the v0 fetch fallback, and the v0 receive-pack push path.
// Handlers take a parsed request and return a response triple; the HTTP
// server in server.ts owns sockets, auth, and body reading.
//
// Advertisement shapes follow git itself: v2 is a capability list headed by
// "version 2"; v0 lists refs with capabilities on the first line after the
// "# service=" preamble. Fetches answer in v2 sections (acknowledgments,
// shallow-info, packfile) or, for v0, as plain NAK/shallow lines followed by
// a sideband-framed pack. Pushes answer with a report-status stream inside
// sideband band 1 when the client negotiated side-band-64k.

import {
  ZERO_OID,
  isAncestor,
  isOid,
  peel,
  pktDecodePrefix,
  pktEncodeMany,
  pktLines,
  planFetch,
  readPack,
  sidebandWrap,
  writePack,
  type DecodedPacket,
  type GitObject,
} from './git.ts';
import { DEFAULT_BRANCH, type ForgeStore, type Repo } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function textResponse(status: number, text: string): GitResponse {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

const V2_CAPS = ['version 2\n', 'fetch=shallow\n', 'ls-refs=unborn\n', 'object-format=sha1\n'];
const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} multi_ack_detailed thin-pack side-band-64k ofs-delta shallow`;
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

/** Sorted ref entries: branches, then tags, each with its peeled commit when annotated. */
function refEntries(store: ForgeStore, repo: Repo): Array<{ ref: string; oid: string; peeled: string | null }> {
  const out: Array<{ ref: string; oid: string; peeled: string | null }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const ref of names) {
    const oid = repo.refs.get(ref)!;
    let peeled: string | null = null;
    if (ref.startsWith('refs/tags/')) {
      const obj = store.lookup(oid);
      if (obj && obj.type === 'tag') {
        const target = peel(store.lookup, oid);
        if (target.oid !== oid) peeled = target.oid;
      }
    }
    out.push({ ref, oid, peeled });
  }
  return out;
}

function v0Advertisement(store: ForgeStore, repo: Repo, service: string, caps: string): Buffer {
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const entries = refEntries(store, repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (entries.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = true;
    const emit = (text: string): void => {
      if (first) {
        lines.push(`${text.slice(0, -1)}\0${caps}\n`);
        first = false;
      } else {
        lines.push(text);
      }
    };
    if (headTip !== null) emit(`${headTip} HEAD\n`);
    for (const e of entries) {
      emit(`${e.oid} ${e.ref}\n`);
      if (e.peeled !== null) emit(`${e.peeled} ${e.ref}^{}\n`);
    }
  }
  lines.push('flush');
  return pktEncodeMany(lines);
}

function v2Advertisement(): Buffer {
  return pktEncodeMany([...V2_CAPS, 'flush']);
}

function advertisementCache(store: ForgeStore, repo: Repo): { v2: Buffer; v0Upload: Buffer; v0Receive: Buffer } {
  const cached = repo.advCache;
  if (cached && cached.version === repo.version) {
    return { v2: cached.v2, v0Upload: cached.v0Upload, v0Receive: cached.v0Receive };
  }
  const built = {
    v2: v2Advertisement(),
    v0Upload: v0Advertisement(store, repo, 'git-upload-pack', V0_UPLOAD_CAPS),
    v0Receive: v0Advertisement(store, repo, 'git-receive-pack', V0_RECEIVE_CAPS),
  };
  repo.advCache = { version: repo.version, ...built };
  return built;
}

/** GET info/refs: v2 when the client asked for it (upload-pack only), else v0. */
export function handleInfoRefs(
  store: ForgeStore,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return textResponse(404, 'repository not found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return textResponse(400, 'unknown service');
  }
  const ads = advertisementCache(store, repo);
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: ads.v2 };
  }
  if (service === 'git-upload-pack') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: ads.v0Upload };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: ads.v0Receive };
}

// -------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: readonly DecodedPacket[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let pastDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (p.kind !== 'data' || !pastDelim) continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsBody(store: ForgeStore, repo: Repo, args: LsRefsArgs): Buffer {
  const cacheKey = JSON.stringify(args);
  const cached = repo.lsCache.get(cacheKey);
  if (cached && cached.version === repo.version) return cached.body;
  const lines: string[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const symref = `refs/heads/${repo.defaultBranch}`;
  if (keep('HEAD')) {
    if (headTip !== null) {
      lines.push(args.symrefs ? `${headTip} HEAD symref-target:${symref}\n` : `${headTip} HEAD\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:${symref}\n`);
    }
  }
  for (const e of refEntries(store, repo)) {
    if (!keep(e.ref)) continue;
    let line = `${e.oid} ${e.ref}`;
    if (args.peel && e.peeled !== null) line += ` peeled:${e.peeled}`;
    lines.push(`${line}\n`);
  }
  const body = pktEncodeMany([...lines, 'flush']);
  repo.lsCache.set(cacheKey, { version: repo.version, body });
  return body;
}

// -------------------------------------------------------------------------------------------
// fetch
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function fetchPackCached(store: ForgeStore, repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = JSON.stringify({
    w: [...args.wants].sort(),
    h: [...args.haves].sort(),
    d: args.depth ?? null,
    s: [...args.shallow].sort(),
  });
  const cached = repo.fetchCache.get(key);
  if (cached && cached.version === repo.version) {
    return { pack: cached.pack, shallow: cached.shallow, unshallow: cached.unshallow };
  }
  const plan = planFetch(store.lookup, args.wants, args.haves, args.depth, args.shallow);
  const objects: GitObject[] = [];
  for (const oid of plan.objects) {
    const obj = store.lookup(oid);
    if (obj) objects.push(obj);
  }
  const pack = writePack(objects);
  repo.fetchCache.set(key, { version: repo.version, pack, shallow: plan.shallow, unshallow: plan.unshallow });
  return { pack, shallow: plan.shallow, unshallow: plan.unshallow };
}

function fetchV2Body(store: ForgeStore, repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktEncodeMany(['acknowledgments\n', 'NAK\n', 'flush']));
  const { pack, shallow, unshallow } = fetchPackCached(store, repo, args);
  const hasObjects = args.wants.length > 0 && pack.length > 32;
  if (shallow.length > 0 || unshallow.length > 0) {
    const lines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(pktEncodeMany(lines));
  }
  if (hasObjects) {
    parts.push(pktEncodeMany(['packfile\n']));
    parts.push(sidebandWrap(1, pack));
    parts.push(pktEncodeMany(['flush']));
  }
  return Buffer.concat(parts);
}

function parseFetchV2Args(packets: readonly DecodedPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  let pastDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (p.kind !== 'data' || !pastDelim) continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not
    // and done need no action: this server always sends whole objects, no
    // progress, and no filtering, which the protocol permits.
  }
  return args;
}

function parseFetchV0Args(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  let rest = body;
  for (let section = 0; section < 2 && rest.length > 0; section++) {
    const { packets, consumed } = pktDecodePrefix(rest);
    for (const line of pktLines(packets)) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) {
        const oid = text.slice(5).split(' ')[0];
        if (isOid(oid)) args.wants.push(oid);
      } else if (text.startsWith('have ')) {
        const oid = text.slice(5).trim();
        if (isOid(oid)) args.haves.push(oid);
      } else if (text.startsWith('shallow ')) {
        const oid = text.slice(8).trim();
        if (isOid(oid)) args.shallow.push(oid);
      } else if (text.startsWith('deepen ')) {
        const n = Number(text.slice(7).trim());
        if (Number.isInteger(n) && n > 0) args.depth = n;
      }
    }
    rest = rest.subarray(consumed);
  }
  return args;
}

function fetchV0Body(store: ForgeStore, repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const { pack, shallow, unshallow } = fetchPackCached(store, repo, args);
  const textLines: Array<string | 'flush'> = [];
  for (const oid of shallow) textLines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) textLines.push(`unshallow ${oid}\n`);
  textLines.push('NAK\n');
  parts.push(pktEncodeMany(textLines));
  if (args.wants.length > 0 && pack.length > 32) {
    parts.push(sidebandWrap(1, pack));
  }
  parts.push(pktEncodeMany(['flush']));
  return Buffer.concat(parts);
}

/** POST git-upload-pack: a v2 command (ls-refs/fetch) or a v0 fetch. */
export function handleUploadPack(
  store: ForgeStore,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | undefined,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return textResponse(404, 'repository not found');
  const contentType = 'application/x-git-upload-pack-result';
  let packets: DecodedPacket[];
  try {
    packets = pktDecodePrefix(body).packets;
  } catch {
    return textResponse(400, 'malformed pkt-line stream');
  }
  const lines = pktLines(packets);
  const firstLine = (lines[0] ?? '').replace(/\n$/, '');
  const isV2 = gitProtocol === 'version=2' || firstLine.startsWith('command=');
  try {
    if (isV2) {
      if (firstLine === 'command=ls-refs') {
        const args = parseLsRefsArgs(packets);
        return { status: 200, contentType, body: lsRefsBody(store, repo, args) };
      }
      if (firstLine === 'command=fetch') {
        const args = parseFetchV2Args(packets);
        return { status: 200, contentType, body: fetchV2Body(store, repo, args) };
      }
      return textResponse(400, 'unknown v2 command');
    }
    const args = parseFetchV0Args(body);
    return { status: 200, contentType, body: fetchV0Body(store, repo, args) };
  } catch (err) {
    return textResponse(400, `fetch failed: ${(err as Error).message}`);
  }
}

// -------------------------------------------------------------------------------------------
// receive-pack (push)
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function validRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length > 200) return false;
  if (/[\s\u0000-\u001f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.endsWith('.lock') || ref.endsWith('/') || ref.includes('//')) return false;
  return true;
}

/** POST git-receive-pack: unpack the pack, then apply or refuse each command. */
export function handleReceivePack(
  store: ForgeStore,
  owner: string,
  repoName: string,
  body: Buffer,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return textResponse(404, 'repository not found');
  const contentType = 'application/x-git-receive-pack-result';

  let commands: PushCommand[] = [];
  let sideband = true;
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const { packets, consumed } = pktDecodePrefix(body);
    packBytes = body.subarray(consumed);
    let first = true;
    for (const line of pktLines(packets)) {
      const text = line.replace(/\n$/, '');
      let commandText = text;
      if (first) {
        first = false;
        const nul = text.indexOf('\0');
        if (nul >= 0) {
          commandText = text.slice(0, nul);
          const caps = text.slice(nul + 1).split(' ');
          sideband = caps.includes('side-band-64k');
        }
      }
      const parts = commandText.split(' ');
      if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1])) {
        throw new Error('bad command line');
      }
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  } catch {
    return textResponse(400, 'malformed receive-pack request');
  }

  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, store.lookup);
      store.storeObjects(objects.values());
    } catch (err) {
      unpackDetail = `error: ${(err as Error).message}`.slice(0, 120);
    }
  }

  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  let changed = false;
  for (const cmd of commands) {
    let verdict: string | null = null; // null = ok, else the ng reason
    if (unpackDetail !== 'ok') {
      verdict = 'unpack failed';
    } else if (!validRefName(cmd.ref)) {
      verdict = 'invalid refname';
    } else if (cmd.newOid === ZERO_OID) {
      const current = repo.refs.get(cmd.ref);
      if (current === undefined) verdict = 'remote ref does not exist';
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) verdict = 'non-fast-forward';
    } else {
      const obj = store.lookup(cmd.newOid);
      if (!obj) {
        verdict = 'object not found';
      } else if (cmd.ref.startsWith('refs/heads/')) {
        const peeled = peel(store.lookup, cmd.newOid);
        if (peeled.type !== 'commit') verdict = 'not a commit';
      }
      if (verdict === null) {
        const current = repo.refs.get(cmd.ref);
        if (cmd.oldOid === cmd.newOid) {
          verdict = null; // a no-op update
        } else if (current === undefined) {
          if (cmd.oldOid !== ZERO_OID) verdict = 'non-fast-forward';
        } else if (cmd.oldOid === ZERO_OID) {
          verdict = 'already exists';
        } else if (cmd.oldOid !== current) {
          verdict = 'non-fast-forward';
        } else if (cmd.ref.startsWith('refs/tags/')) {
          verdict = 'non-fast-forward'; // tags do not move
        } else if (!isAncestor(store.lookup, cmd.oldOid, cmd.newOid)) {
          verdict = 'non-fast-forward';
        }
      }
    }
    if (verdict === null) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else if (cmd.oldOid !== cmd.newOid) repo.refs.set(cmd.ref, cmd.newOid);
      changed = true;
      reportLines.push(`ok ${cmd.ref}\n`);
    } else {
      reportLines.push(`ng ${cmd.ref} ${verdict}\n`);
    }
  }
  if (changed) store.bump(repo);

  const report = pktEncodeMany([...reportLines, 'flush']);
  const framed = sideband ? Buffer.concat([sidebandWrap(1, report), pktEncodeMany(['flush'])]) : report;
  return { status: 200, contentType, body: framed };
}
