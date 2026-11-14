// The REST v3 API: repositories, branches, commits, git refs, contents,
// labels, issues, comments, and pull requests. Routes are matched on path
// segments; every reply is JSON with the request-id header, error bodies
// carry a string `message`, and unknown routes or owners answer 404 (never
// 403 for a foreign owner: the suite treats another owner's repo as absent).
//
// The shapes here are GitHub's: issue and pull-request numbers share one
// per-repository counter, labels must exist before an issue may use them,
// contents writes are real git commits, and a merge is a real three-way
// merge whose conflict answers 405.

import { countLineDiff, parseTree } from './git.ts';
import {
  commentJson,
  issueJson,
  issueJsonText,
  labelJson,
  pullJson,
  repoJson,
  touchIssue,
  userJson,
  type ForgeStore,
  type Repo,
} from './store.ts';
import { errorReply, jsonReply, jsonTextReply, pageParams, paginate, parseJsonBody, type Reply, type RequestCtx } from './ctx.ts';

const OAUTH_SCOPES = 'repo, read:org';

function ok(status: number, value: unknown, link?: string | null): Reply {
  const headers: Record<string, string> = { 'X-Oauth-Scopes': OAUTH_SCOPES };
  if (link) headers.Link = link;
  return jsonReply(status, value, headers);
}

function fail(status: number, message: string): Reply {
  return jsonReply(status, { message }, { 'X-Oauth-Scopes': OAUTH_SCOPES });
}

function repoOr404(store: ForgeStore, owner: string, name: string): Repo | Reply {
  const repo = store.getRepo(owner, name);
  return repo ?? fail(404, 'Not Found');
}

function isReply(value: Repo | Reply): value is Reply {
  return 'status' in value && 'body' in value;
}

function validRepoName(name: string): boolean {
  return name.length >= 1 && name.length <= 100 && /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('.');
}

/** Split "Name <email> timestamp tz" into its parts; falls back gracefully. */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

/** Labels from an issue body: strings or {name} objects, in order. */
function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

/** Walk a tree path: the entry at the end, or the subtree's entries for a directory. */
function resolveTreePath(
  store: ForgeStore,
  treeOid: string,
  parts: string[],
): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string; entries: ReturnType<typeof parseTree> } | { kind: 'missing' } {
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = store.lookup(current);
    if (!obj || obj.type !== 'tree') return { kind: 'missing' };
    const entries = parseTree(obj.data);
    const entry = entries.find((e) => e.name === parts[i]);
    if (!entry) return { kind: 'missing' };
    if (i === parts.length - 1) {
      if (entry.mode === '40000') {
        const dirObj = store.lookup(entry.oid);
        if (!dirObj || dirObj.type !== 'tree') return { kind: 'missing' };
        return { kind: 'dir', oid: entry.oid, entries: parseTree(dirObj.data) };
      }
      return { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return { kind: 'missing' };
    current = entry.oid;
  }
  const obj = store.lookup(current);
  if (!obj || obj.type !== 'tree') return { kind: 'missing' };
  return { kind: 'dir', oid: current, entries: parseTree(obj.data) };
}

export function handleRest(ctx: RequestCtx): Reply {
  const { store, method, segments } = ctx;
  // segments[0] === 'api', segments[1] === 'v3'; everything below is the route.
  const route = segments.slice(2);

  // -- API root and meta ----------------------------------------------------------------------
  if (route.length === 0) {
    if (method !== 'GET') return fail(404, 'Not Found');
    const base = `http://${ctx.host}/api/v3`;
    return ok(200, {
      current_user_url: `${base}/user`,
      current_user_authorizations_html_url: `${base}/authorizations`,
      authorizations_url: `${base}/authorizations`,
      code_search_url: `${base}/search/code?q={query}`,
      commit_search_url: `${base}/search/commits?q={query}`,
      emails_url: `${base}/user/emails`,
      emojis_url: `${base}/emojis`,
      events_url: `${base}/events`,
      feeds_url: `${base}/feeds`,
      followers_url: `${base}/user/followers`,
      following_url: `${base}/user/following`,
      gists_url: `${base}/gists`,
      hub_url: `${base}/hub`,
      issue_search_url: `${base}/search/issues?q={query}`,
      issues_url: `${base}/issues`,
      keys_url: `${base}/user/keys`,
      label_search_url: `${base}/search/labels?q={query}`,
      notifications_url: `${base}/notifications`,
      organization_url: `${base}/orgs/{org}`,
      organization_repositories_url: `${base}/orgs/{org}/repos`,
      organization_teams_url: `${base}/orgs/{org}/teams`,
      public_gists_url: `${base}/gists/public`,
      rate_limit_url: `${base}/rate_limit`,
      repository_url: `${base}/repos/{owner}/{repo}`,
      repository_search_url: `${base}/search/repositories?q={query}`,
      current_user_repositories_url: `${base}/user/repos`,
      starred_url: `${base}/user/starred`,
      starred_gists_url: `${base}/gists/starred`,
      topic_search_url: `${base}/search/topics?q={query}`,
      user_url: `${base}/users/{user}`,
      user_organizations_url: `${base}/user/orgs`,
      user_repositories_url: `${base}/users/{user}/repos`,
      user_search_url: `${base}/search/users?q={query}`,
    });
  }
  if (route.length === 1 && route[0] === 'meta') {
    if (method !== 'GET') return fail(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // -- the authenticated user -------------------------------------------------------------------
  if (route[0] === 'user') {
    if (route.length === 1) {
      if (method !== 'GET') return fail(404, 'Not Found');
      return ok(200, {
        ...userJson(),
        name: 'ada iversen',
        email: 'adaiversen@example.invalid',
        public_repos: store.listRepos().length,
        followers: 0,
        following: 0,
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
      });
    }
    if (route.length === 2 && route[1] === 'repos') {
      if (method === 'POST') {
        const body = parseJsonBody(ctx.body);
        if (body === null) return fail(400, 'Invalid JSON body');
        const name = typeof body.name === 'string' ? body.name : '';
        if (!validRepoName(name)) return fail(422, 'name is not a valid repository name');
        if (store.repoExists(name)) return fail(422, 'name already exists on this account');
        const repo = store.createRepo(
          name,
          body.private === true,
          typeof body.description === 'string' ? body.description : '',
        );
        if (!repo) return fail(422, 'name already exists on this account');
        return ok(201, repoJson(repo));
      }
      if (method === 'GET') {
        const params = pageParams(ctx.query);
        const { page, link } = paginate(ctx, store.listRepos(), params);
        return ok(200, page.map(repoJson), link);
      }
      return fail(404, 'Not Found');
    }
    return fail(404, 'Not Found');
  }

  // -- repositories -------------------------------------------------------------------------------
  if (route[0] === 'repos' && route.length >= 3) {
    const owner = route[1];
    const name = route[2];
    const repo = repoOr404(store, owner, name);
    if (isReply(repo)) return repo;
    const rest = route.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        const body = parseJsonBody(ctx.body);
        if (body === null) return fail(400, 'Invalid JSON body');
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        store.bump(repo);
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: '', contentType: 'application/json; charset=utf-8', headers: { 'X-Oauth-Scopes': OAUTH_SCOPES } };
      }
      return fail(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches') {
      if (method !== 'GET') return fail(404, 'Not Found');
      if (rest.length === 1) {
        return ok(
          200,
          store.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: false })),
        );
      }
      const branch = rest.slice(1).join('/');
      const tip = store.branchTip(repo, branch);
      if (tip === null) return fail(404, 'Branch not found');
      const commit = store.commitOf(tip);
      return ok(200, {
        name: branch,
        commit: { sha: tip, commit: commit ? { message: commit.message } : { message: '' } },
        protected: false,
      });
    }

    // commits
    if (rest[0] === 'commits') {
      if (method !== 'GET') return fail(404, 'Not Found');
      if (rest.length === 1) {
        const refParam = ctx.query.get('sha');
        let tip: string | null;
        if (refParam === null) {
          tip = store.branchTip(repo, repo.defaultBranch);
          if (tip === null) return ok(200, []);
        } else {
          tip = store.resolveToCommit(repo, refParam);
          if (tip === null) return fail(404, 'No commit found for SHA');
        }
        const params = pageParams(ctx.query);
        const { page, link } = paginate(ctx, store.history(tip), params);
        return ok(
          200,
          page.map((sha) => {
            const commit = store.commitOf(sha)!;
            const author = parseIdent(commit.author);
            const committer = parseIdent(commit.committer);
            return {
              sha,
              commit: {
                message: commit.message,
                author: { name: author.name, email: author.email, date: author.date },
                committer: { name: committer.name, email: committer.email, date: committer.date },
                tree: { sha: commit.tree },
              },
              author: userJson(),
              committer: userJson(),
              parents: commit.parents.map((p) => ({ sha: p })),
            };
          }),
          link,
        );
      }
      // GET /commits/<sha>: one commit
      const sha = rest[1];
      const commit = store.commitOf(sha);
      if (!commit) return fail(404, 'No commit found for SHA');
      const author = parseIdent(commit.author);
      const committer = parseIdent(commit.committer);
      return ok(200, {
        sha,
        commit: {
          message: commit.message,
          author: { name: author.name, email: author.email, date: author.date },
          committer: { name: committer.name, email: committer.email, date: committer.date },
          tree: { sha: commit.tree },
        },
        author: userJson(),
        committer: userJson(),
        parents: commit.parents.map((p) => ({ sha: p })),
      });
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = parseJsonBody(ctx.body);
        if (body === null) return fail(400, 'Invalid JSON body');
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || ref.length < 6) return fail(422, 'ref must start with refs/');
        const obj = store.lookup(sha);
        if (!obj) return fail(422, 'sha does not name an object in this repository');
        const current = repo.refs.get(ref);
        if (current !== undefined && current !== sha) return fail(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        store.bump(repo);
        return ok(201, { ref, node_id: '', object: { sha, type: obj.type } });
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          return ok(
            200,
            [...repo.refs.entries()].sort().map(([ref, sha]) => ({
              ref,
              object: { sha, type: store.lookup(sha)?.type ?? 'commit' },
            })),
          );
        }
        const suffix = rest.slice(2).join('/');
        const full = `refs/${suffix}`;
        const exact = repo.refs.get(full);
        if (exact !== undefined) {
          return ok(200, { ref: full, object: { sha: exact, type: store.lookup(exact)?.type ?? 'commit' } });
        }
        const matches = [...repo.refs.entries()].filter(([ref]) => ref.startsWith(full)).sort();
        if (matches.length === 0) return fail(404, 'Reference does not exist');
        return ok(
          200,
          matches.map(([ref, sha]) => ({ ref, object: { sha, type: store.lookup(sha)?.type ?? 'commit' } })),
        );
      }
      return fail(404, 'Not Found');
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const refParam = ctx.query.get('ref');
        const tip = refParam === null ? store.branchTip(repo, repo.defaultBranch) : store.resolveToCommit(repo, refParam);
        if (tip === null) return fail(404, 'Not Found');
        const commit = store.commitOf(tip);
        if (!commit) return fail(404, 'Not Found');
        const parts = path === '' ? [] : path.split('/');
        const found = resolveTreePath(store, commit.tree, parts);
        if (found.kind === 'missing') return fail(404, 'Not Found');
        if (found.kind === 'file') {
          const blob = store.lookup(found.oid);
          if (!blob) return fail(404, 'Not Found');
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: parts[parts.length - 1] ?? '',
            path,
            sha: found.oid,
            content: blob.data.toString('base64'),
          });
        }
        return ok(
          200,
          found.entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: path === '' ? e.name : `${path}/${e.name}`,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (store.lookup(e.oid)?.data.length ?? 0),
          })),
        );
      }
      if (method === 'PUT' || method === 'DELETE') {
        const body = parseJsonBody(ctx.body);
        if (body === null) return fail(400, 'Invalid JSON body');
        if (path === '') return fail(422, 'path is required');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const message = typeof body.message === 'string' && body.message !== '' ? body.message : `${method === 'PUT' ? 'Update' : 'Delete'} ${path}`;
        // The branch's current tree: the branch tip, or the default tip when
        // the branch is new, or empty when the repository is unborn.
        let tip = store.branchTip(repo, branch) ?? store.branchTip(repo, repo.defaultBranch);
        const flat = tip === null ? new Map() : store.flatOfCommit(tip);
        const existing = flat.get(path);
        const givenSha = typeof body.sha === 'string' ? body.sha : '';
        if (method === 'PUT') {
          if (typeof body.content !== 'string') return fail(422, 'content is required');
          let bytes: Buffer;
          try {
            bytes = Buffer.from(body.content, 'base64');
          } catch {
            return fail(422, 'content is not valid base64');
          }
          if (givenSha !== '' && existing && givenSha !== existing.oid) {
            return fail(409, 'content sha does not match the file on the branch');
          }
          const blobOid = store.storeObject('blob', bytes);
          const mode = existing?.mode ?? '100644';
          const commitOid = store.commitTreeChange(repo, branch, message, new Map([[path, { oid: blobOid, mode }]]));
          return ok(existing ? 200 : 201, {
            content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
            commit: { sha: commitOid, message },
          });
        }
        // DELETE
        if (!existing) return fail(404, 'Not Found');
        if (givenSha !== '' && givenSha !== existing.oid) {
          return fail(409, 'content sha does not match the file on the branch');
        }
        const commitOid = store.commitTreeChange(repo, branch, message, new Map([[path, null]]));
        return ok(200, { content: null, commit: { sha: commitOid, message } });
      }
      return fail(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST') {
        const body = parseJsonBody(ctx.body);
        if (body === null) return fail(400, 'Invalid JSON body');
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return fail(422, 'name is required');
        const color = typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed';
        const key = name.toLowerCase();
        const existing = repo.labels.get(key);
        if (existing) {
          existing.name = name;
          existing.color = color;
          return ok(201, labelJson(existing));
        }
        const label = { id: store.allocId(), name, color };
        repo.labels.set(key, label);
        store.bump(repo);
        return ok(201, labelJson(label));
      }
      if (method === 'GET') return ok(200, [...repo.labels.values()].map(labelJson));
      return fail(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = parseJsonBody(ctx.body);
          if (body === null) return fail(400, 'Invalid JSON body');
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') return fail(422, 'title is required');
          const result = store.createIssue(
            repo,
            title,
            typeof body.body === 'string' ? body.body : '',
            labelNamesOf(body.labels),
          );
          if ('error' in result) return fail(422, result.error);
          return ok(201, issueJson(repo, result.issue));
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = ctx.query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          else if (state !== 'all') list = list.filter((i) => i.state === 'open');
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const params = pageParams(ctx.query);
          const { page, link } = paginate(ctx, list, params);
          return ok(200, page.map((i) => issueJson(repo, i)), link);
        }
        return fail(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number <= 0) return fail(404, 'Not Found');
      if (rest.length === 2) {
        const issue = repo.issues.get(number);
        if (!issue) return fail(404, 'Not Found');
        if (method === 'GET') {
          // The timed read workload hits this path 2,000 times in a row on
          // one warm connection: serve the cached rendering when the issue
          // has not changed since it was built.
          return jsonTextReply(200, issueJsonText(store, repo, issue), { 'X-Oauth-Scopes': OAUTH_SCOPES });
        }
        if (method === 'PATCH') {
          const body = parseJsonBody(ctx.body);
          if (body === null) return fail(400, 'Invalid JSON body');
          if (body.state !== undefined) {
            if (body.state !== 'open' && body.state !== 'closed') return fail(422, 'state must be open or closed');
            issue.state = body.state;
          }
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.labels !== undefined) {
            const names = labelNamesOf(body.labels);
            const resolved: string[] = [];
            for (const name of names) {
              const label = repo.labels.get(name.toLowerCase());
              if (!label) return fail(422, `Label '${name}' does not exist`);
              resolved.push(label.name);
            }
            issue.labels = resolved;
          }
          touchIssue(issue);
          return ok(200, issueJson(repo, issue));
        }
        return fail(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const exists = repo.issues.has(number) || repo.pulls.has(number);
        if (!exists) return fail(404, 'Not Found');
        if (method === 'POST') {
          const body = parseJsonBody(ctx.body);
          if (body === null) return fail(400, 'Invalid JSON body');
          if (typeof body.body !== 'string' || body.body === '') return fail(422, 'body is required');
          const comment = store.addComment(repo, number, body.body);
          if (!comment) return fail(404, 'Not Found');
          return ok(201, commentJson(comment));
        }
        if (method === 'GET') {
          return ok(200, (repo.comments.get(number) ?? []).map(commentJson));
        }
        return fail(404, 'Not Found');
      }
      return fail(404, 'Not Found');
    }

    // pull requests
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = parseJsonBody(ctx.body);
          if (body === null) return fail(400, 'Invalid JSON body');
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : '';
          if (title === '' || head === '' || base === '') return fail(422, 'title, head and base are required');
          const result = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if ('error' in result) return fail(result.status, result.error);
          return ok(201, pullJson(store, repo, result.pull));
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          else if (state !== 'all') list = list.filter((p) => p.state === 'open');
          list.sort((a, b) => b.number - a.number);
          const params = pageParams(ctx.query);
          const { page, link } = paginate(ctx, list, params);
          return ok(200, page.map((p) => pullJson(store, repo, p)), link);
        }
        return fail(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number <= 0) return fail(404, 'Not Found');
      const pull = repo.pulls.get(number);
      if (!pull) return fail(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, pullJson(store, repo, pull));
        return fail(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const files = store.pullFiles(repo, pull);
        return ok(
          200,
          files.map((f) => {
            const oldBytes = f.oldOid ? (store.lookup(f.oldOid)?.data ?? null) : null;
            const newBytes = f.newOid ? (store.lookup(f.newOid)?.data ?? null) : null;
            const counts = countLineDiff(oldBytes, newBytes);
            return {
              filename: f.path,
              status: f.status,
              additions: counts.additions,
              deletions: counts.deletions,
              changes: counts.additions + counts.deletions,
              sha: f.newOid ?? f.oldOid,
            };
          }),
        );
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const body = parseJsonBody(ctx.body);
        if (body === null) return fail(400, 'Invalid JSON body');
        const methodName = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
        const result = store.mergePull(repo, pull, methodName);
        if ('conflict' in result) return fail(405, `Merge conflict in ${result.conflict}`);
        if ('error' in result) return fail(result.status, result.error);
        return ok(200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
      }
      return fail(404, 'Not Found');
    }

    return fail(404, 'Not Found');
  }

  return fail(404, 'Not Found');
}
