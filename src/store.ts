// The forge's store: every repository, issue, pull request, label and
// comment, plus the one content-addressed object store all repositories
// share (an object id is a pure function of its bytes, so sharing is safe;
// reachability is always computed per repository from its own refs).
//
// Everything lives in memory. The suite drives one fresh process per trial,
// so there is nothing to persist, and in-memory Maps keep the timed
// workloads fast. Each repository carries a version counter that every
// mutation bumps; the git layer's pack/advertisement caches key off it, and
// each issue carries its own revision for its cached JSON rendering.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  diffFlat,
  flattenTree,
  hashObject,
  isOid,
  mergeBase,
  mergeFlat,
  parseCommit,
  peel,
  type FlatEntry,
  type GitObject,
  type Lookup,
  type ObjType,
} from './git.ts';

/** The token owner's login, from the suite's one fixed scenario seed. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';

/** Labels every repository starts with, as the suite's scenario names them. */
const SEED_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'documentation', color: '0075ca' },
  { name: 'question', color: 'd876e3' },
  { name: 'good first issue', color: '7057ff' },
  { name: 'help wanted', color: '008672' },
];

export interface Label {
  readonly id: number;
  name: string;
  color: string;
}

export interface Issue {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  rev: number;
  cachedJson: string | null;
}

export interface Pull {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  readonly createdAt: string;
  updatedAt: string;
  rev: number;
}

export interface Comment {
  readonly id: number;
  readonly nodeId: string;
  body: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly nodeId: string;
  readonly name: string;
  readonly owner: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  readonly labels: Map<string, Label>;
  readonly comments: Map<number, Comment[]>;
  nextNumber: number;
  version: number;
  /** Fetch pack cache: key -> pack bytes + shallow info, valid at `version`. */
  fetchCache: Map<string, { version: number; pack: Buffer; shallow: string[]; unshallow: string[] }>;
  /** Advertisement cache, valid at `version`. */
  advCache: { version: number; v2: Buffer; v0Upload: Buffer; v0Receive: Buffer } | null;
  /** ls-refs cache keyed by the argument signature, valid at `version`. */
  lsCache: Map<string, { version: number; body: Buffer }>;
}

/** Opaque Relay-style global ids: base64 over a typed key, stable across reads. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

function identLine(): string {
  const ts = Math.floor(Date.now() / 1000);
  return `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${ts} +0000`;
}

export class ForgeStore {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private nextId = 1;
  private commitCache = new Map<string, ReturnType<typeof parseCommit>>();

  /** Bound object lookup for the git layer's walks. */
  lookup: Lookup = (oid: string) => this.objects.get(oid);

  allocId(): number {
    return this.nextId++;
  }

  /** Store an object if absent; returns its id. */
  storeObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  storeObjects(objects: Iterable<GitObject>): void {
    for (const obj of objects) {
      const oid = hashObject(obj.type, obj.data);
      if (!this.objects.has(oid)) this.objects.set(oid, { type: obj.type, data: obj.data });
    }
  }

  /** A parsed commit, cached: walks re-read the same commits constantly. */
  commitOf(oid: string): ReturnType<typeof parseCommit> | null {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const parsed = parseCommit(obj.data);
    if (this.commitCache.size > 50000) this.commitCache.clear();
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  // -- repositories ---------------------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** A repository only exists under the token owner's login; any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  repoExists(name: string): boolean {
    return this.repos.has(this.repoKey(VIEWER_LOGIN, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repoExists(name)) return null;
    const id = this.allocId();
    const stamp = nowIso();
    const repo: Repo = {
      id,
      nodeId: globalId('Repository', String(id)),
      name,
      owner: VIEWER_LOGIN,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: stamp,
      updatedAt: stamp,
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      version: 0,
      fetchCache: new Map(),
      advCache: null,
      lsCache: new Map(),
    };
    for (const seed of SEED_LABELS) {
      repo.labels.set(seed.name.toLowerCase(), { id: this.allocId(), name: seed.name, color: seed.color });
    }
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    this.reposById.set(id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.repos.delete(this.repoKey(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  bump(repo: Repo): void {
    repo.version++;
    repo.updatedAt = nowIso();
    repo.fetchCache.clear();
    repo.advCache = null;
    repo.lsCache.clear();
  }

  // -- refs and history -------------------------------------------------------------------------

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Resolve a branch name, tag name, or object id to a commit id. */
  resolveToCommit(repo: Repo, ref: string): string | null {
    let oid: string | null = null;
    if (repo.refs.has(`refs/heads/${ref}`)) oid = repo.refs.get(`refs/heads/${ref}`)!;
    else if (repo.refs.has(`refs/tags/${ref}`)) oid = repo.refs.get(`refs/tags/${ref}`)!;
    else if (repo.refs.has(ref)) oid = repo.refs.get(ref)!;
    else if (isOid(ref) && this.objects.has(ref)) oid = ref;
    if (oid === null) return null;
    const peeled = peel(this.lookup, oid);
    return peeled.type === 'commit' ? peeled.oid : null;
  }

  /** Commit history newest-first from a tip, following parents depth-first. */
  history(tip: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(oid);
      if (!commit) continue;
      out.push(oid);
      for (let i = commit.parents.length - 1; i >= 0; i--) {
        if (!seen.has(commit.parents[i])) stack.push(commit.parents[i]);
      }
    }
    return out;
  }

  /** Create a commit object (no ref update); callers move the ref. */
  createCommit(tree: string, parents: readonly string[], message: string): string {
    const ident = identLine();
    const data = buildCommit({ tree, parents, author: ident, committer: ident, message });
    return this.storeObject('commit', data);
  }

  /**
   * Apply path changes to a branch's tree and commit. `branch` is created
   * from the default branch when it does not exist yet; an empty repository
   * starts from the empty tree. `changes` maps a path to its new blob entry,
   * or null to delete the path. Returns the new commit id.
   */
  commitTreeChange(
    repo: Repo,
    branch: string,
    message: string,
    changes: Map<string, FlatEntry | null>,
  ): string {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref) ?? null;
    let baseFlat = new Map<string, FlatEntry>();
    if (tip !== null) {
      const commit = this.commitOf(tip);
      if (commit) baseFlat = new Map(flattenTree(this.lookup, commit.tree));
    } else {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      if (defaultTip !== null) {
        tip = defaultTip;
        const commit = this.commitOf(defaultTip);
        if (commit) baseFlat = new Map(flattenTree(this.lookup, commit.tree));
      }
    }
    for (const [path, change] of changes) {
      if (change === null) baseFlat.delete(path);
      else baseFlat.set(path, change);
    }
    const tree = buildTreeFromFlat(baseFlat, (type, data) => this.storeObject(type, data));
    const parents = tip !== null ? [tip] : [];
    const commitOid = this.createCommit(tree, parents, message);
    repo.refs.set(ref, commitOid);
    this.bump(repo);
    return commitOid;
  }

  /** The flat path map of a commit's tree (empty when the commit is unknown). */
  flatOfCommit(commitOid: string): Map<string, FlatEntry> {
    const commit = this.commitOf(commitOid);
    if (!commit) return new Map();
    return flattenTree(this.lookup, commit.tree);
  }

  // -- issues -----------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): { issue: Issue } | { error: string } {
    const labels: string[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name.toLowerCase());
      if (!label) return { error: `Label '${name}' does not exist` };
      labels.push(label.name);
    }
    const id = this.allocId();
    const number = repo.nextNumber++;
    const stamp = nowIso();
    const issue: Issue = {
      id,
      nodeId: globalId('Issue', `${repo.id}:${number}`),
      number,
      title,
      body,
      state: 'open',
      labels,
      createdAt: stamp,
      updatedAt: stamp,
      rev: 0,
      cachedJson: null,
    };
    repo.issues.set(number, issue);
    this.bump(repo);
    return { issue };
  }

  addComment(repo: Repo, number: number, body: string): Comment | null {
    if (!repo.issues.has(number) && !repo.pulls.has(number)) return null;
    const id = this.allocId();
    const stamp = nowIso();
    const comment: Comment = {
      id,
      nodeId: globalId('IssueComment', `${repo.id}:${id}`),
      body,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    const issue = repo.issues.get(number);
    if (issue) {
      issue.rev++;
      issue.cachedJson = null;
    }
    this.bump(repo);
    return comment;
  }

  // -- pull requests ------------------------------------------------------------------------------

  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
  ): { pull: Pull } | { error: string; status: number } {
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, base);
    if (headTip === null) return { error: `Head branch '${head}' does not exist`, status: 422 };
    if (baseTip === null) return { error: `Base branch '${base}' does not exist`, status: 422 };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return { error: 'A pull request already exists for these branches', status: 422 };
      }
    }
    const id = this.allocId();
    const number = repo.nextNumber++;
    const stamp = nowIso();
    const pull: Pull = {
      id,
      nodeId: globalId('PullRequest', `${repo.id}:${number}`),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      createdAt: stamp,
      updatedAt: stamp,
      rev: 0,
    };
    repo.pulls.set(number, pull);
    this.bump(repo);
    return { pull };
  }

  /** The merge-base of a pull request's current head and base tips. */
  pullMergeBase(repo: Repo, pull: Pull): string | null {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return null;
    return mergeBase(this.lookup, baseTip, headTip);
  }

  /** The file-level diff of a pull request: merge-base tree against the head tree. */
  pullFiles(repo: Repo, pull: Pull): ReturnType<typeof diffFlat> {
    const headTip = this.branchTip(repo, pull.headRef);
    if (headTip === null) return [];
    const base = this.pullMergeBase(repo, pull);
    const baseFlat = base === null ? new Map<string, FlatEntry>() : this.flatOfCommit(base);
    return diffFlat(baseFlat, this.flatOfCommit(headTip));
  }

  /** Whether a pull request would merge cleanly right now. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return 'UNKNOWN';
    const base = this.pullMergeBase(repo, pull);
    const baseFlat = base === null ? new Map<string, FlatEntry>() : this.flatOfCommit(base);
    const outcome = mergeFlat(baseFlat, this.flatOfCommit(baseTip), this.flatOfCommit(headTip));
    return 'conflict' in outcome ? 'CONFLICTING' : 'MERGEABLE';
  }

  mergePull(
    repo: Repo,
    pull: Pull,
    method: string,
  ): { sha: string } | { conflict: string } | { error: string; status: number } {
    if (pull.state !== 'open' || pull.merged) {
      return { error: 'Pull request is not open', status: 405 };
    }
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) {
      return { error: 'Head or base branch does not exist', status: 422 };
    }
    const base = this.pullMergeBase(repo, pull);
    const baseFlat = base === null ? new Map<string, FlatEntry>() : this.flatOfCommit(base);
    const outcome = mergeFlat(baseFlat, this.flatOfCommit(baseTip), this.flatOfCommit(headTip));
    if ('conflict' in outcome) return { conflict: outcome.conflict };
    const tree = buildTreeFromFlat(outcome.merged, (type, data) => this.storeObject(type, data));
    const normalized = method.toLowerCase();
    const isMergeCommit = normalized === 'merge';
    const parents = isMergeCommit ? [baseTip, headTip] : [baseTip];
    const message = isMergeCommit
      ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`
      : `${pull.title} (#${pull.number})`;
    const sha = this.createCommit(tree, parents, message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = nowIso();
    pull.rev++;
    this.bump(repo);
    return { sha };
  }
}

// -------------------------------------------------------------------------------------------
// JSON shapes shared by REST, GraphQL and MCP
// -------------------------------------------------------------------------------------------

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', String(VIEWER_ID)),
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    fork: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: globalId('Label', String(label.id)), name: label.name, color: label.color, description: '' };
}

export function issueLabelsJson(repo: Repo, issue: Issue): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const name of issue.labels) {
    const label = repo.labels.get(name.toLowerCase());
    if (label) out.push(labelJson(label));
  }
  return out;
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issueLabelsJson(repo, issue),
    user: userJson(),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: repo.comments.get(issue.number)?.length ?? 0,
    locked: false,
  };
}

/** The cached rendering of one issue; invalidated by bumping the issue's revision. */
export function issueJsonText(store: ForgeStore, repo: Repo, issue: Issue): string {
  void store;
  if (issue.cachedJson !== null) return issue.cachedJson;
  const text = JSON.stringify(issueJson(repo, issue));
  issue.cachedJson = text;
  return text;
}

export function touchIssue(issue: Issue): void {
  issue.rev++;
  issue.cachedJson = null;
  issue.updatedAt = nowIso();
}

export function pullJson(store: ForgeStore, repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? store.pullMergeable(repo, pull) === 'MERGEABLE' : null,
    head: {
      ref: pull.headRef,
      sha: headTip,
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseTip,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoJson(repo),
    },
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    draft: false,
  };
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export { ZERO_OID };
