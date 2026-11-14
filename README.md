# Forge — a GitHub-compatible git forge in one Node process

A single-process forge that speaks the four surfaces a GitHub client
expects, all backed by one in-memory store:

- **Git smart HTTP** (`git-upload-pack` / `git-receive-pack`, protocol v0
  and v2): clone, fetch, shallow fetch, push, branch and tag updates,
  with real packfiles, delta decoding, and sideband framing.
- **REST v3** (`/api/v3`): repositories, branches, refs, commits,
  contents, labels, issues, comments, and pull requests, with pagination
  and GitHub-shaped JSON.
- **GraphQL** (`/api/graphql`): viewer, repository, issue and pull request
  queries and mutations, cursor connections, and schema introspection.
- **MCP** (`/mcp`): JSON-RPC 2.0 tools for creating and reading repos,
  issues, and pull requests, in both the `server/discover` era and the
  legacy `initialize` era.

## Running

```sh
node main.ts
```

`main.ts` binds an ephemeral port, registers it with the environment
named by `MAKEFUN_ENV_URL`, serves until the environment reports done,
then exits. `MAKEFUN_SHOP_TOKEN` holds the bearer token clients must
present. Node 22.18 or newer; no dependencies beyond the standard
library.

## Layout

- `main.ts` — trial lifecycle: bind, register, poll done, exit.
- `src/server.ts` — HTTP routing, authentication, body handling.
- `src/git.ts` — the git object model: hashing, parsing, packs, deltas,
  pkt-lines, reachability, merging, and diffing.
- `src/store.ts` — the forge state: repositories, refs, issues, pull
  requests, and their REST shapes.
- `src/githttp.ts` — the smart HTTP protocol: advertisements, ls-refs,
  fetch, and receive-pack.
- `src/rest.ts` — the REST v3 router.
- `src/graphql.ts` — a small GraphQL lexer, parser, and executor.
- `src/mcp.ts` — the MCP endpoint and its six tools.
- `src/ctx.ts` — shared request/reply plumbing.

Everything is erasable TypeScript: no enums, no namespaces, no parameter
properties, so Node's type stripping runs it as-is.
