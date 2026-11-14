// GraphQL over POST /api/graphql: a small lexer, a recursive-descent parser
// for the document subset gh and github-mcp-server send, and an executor
// driven by resolver tables. Values carry their own __typename, so fragment
// type conditions and sub-selections resolve from the runtime value rather
// than a static schema. Unknown fields are GraphQL errors on a 200, never
// an HTTP error; unknown repositories read as null with no errors; a JSON
// array body is GitHub's operation batching and answers in order.

import { VIEWER_LOGIN, parseGlobalId, type ForgeStore, type Issue, type Pull, type Repo } from './store.ts';
import { errorReply, jsonReply, type Reply, type RequestCtx } from './ctx.ts';

// -------------------------------------------------------------------------------------------
// Lexer
// -------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'ellipsis' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const advance = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      if (source[i] === '\n') {
        line++;
        column = 1;
      } else {
        column++;
      }
      i++;
    }
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    const startLine = line;
    const startCol = column;
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'ellipsis', value: '...', line: startLine, column: startCol });
      advance(3);
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, line: startLine, column: startCol });
      advance();
      continue;
    }
    if (ch === '"') {
      if (source[i + 1] === '"' && source[i + 2] === '"') {
        advance(3);
        let text = '';
        while (i < source.length && !(source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"')) {
          text += source[i];
          advance();
        }
        if (i >= source.length) throw new Error('unterminated block string');
        advance(3);
        tokens.push({ kind: 'string', value: text, line: startLine, column: startCol });
        continue;
      }
      advance();
      let text = '';
      for (;;) {
        if (i >= source.length) throw new Error('unterminated string');
        const c = source[i];
        if (c === '"') {
          advance();
          break;
        }
        if (c === '\\') {
          advance();
          const esc = source[i];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            const hex = source.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad unicode escape');
            text += String.fromCharCode(parseInt(hex, 16));
            advance(5);
          } else if (map[esc] !== undefined) {
            text += map[esc];
            advance();
          } else {
            throw new Error(`bad escape \\${esc}`);
          }
          continue;
        }
        text += c;
        advance();
      }
      tokens.push({ kind: 'string', value: text, line: startLine, column: startCol });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let num = '';
      if (ch === '-') {
        num += '-';
        advance();
      }
      while (i < source.length && /[0-9]/.test(source[i])) {
        num += source[i];
        advance();
      }
      let isFloat = false;
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        isFloat = true;
        num += '.';
        advance();
        while (i < source.length && /[0-9]/.test(source[i])) {
          num += source[i];
          advance();
        }
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        num += source[i];
        advance();
        if (source[i] === '+' || source[i] === '-') {
          num += source[i];
          advance();
        }
        while (i < source.length && /[0-9]/.test(source[i])) {
          num += source[i];
          advance();
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: num, line: startLine, column: startCol });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let name = '';
      while (i < source.length && /[_0-9A-Za-z]/.test(source[i])) {
        name += source[i];
        advance();
      }
      tokens.push({ kind: 'name', value: name, line: startLine, column: startCol });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${line}:${column}`);
  }
  tokens.push({ kind: 'eof', value: '', line, column });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// Parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): Token {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected "${value}", got "${t.value}"`);
    return t;
  }

  private expectName(value?: string): Token {
    const t = this.next();
    if (t.kind !== 'name' || (value !== undefined && t.value !== value)) {
      throw new Error(`expected name ${value ?? ''}, got "${t.value}"`);
    }
    return t;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName().value;
      this.expectName('on');
      const typeCondition = this.expectName().value;
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, variables, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token "${t.value}" at ${t.line}:${t.column}`);
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName().value;
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue(true);
        }
        this.skipDirectives();
        defs.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'ellipsis') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName().value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName().value;
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName().value;
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName().value;
        this.expectPunct(':');
        args.push({ name, value: this.parseValue(false) });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new Error('variables are not allowed in constant values');
      return { kind: 'variable', name: this.expectName().value };
    }
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token "${t.value}"`);
  }
}

// -------------------------------------------------------------------------------------------
// Values carried through execution (each knows its own GraphQL type)
// -------------------------------------------------------------------------------------------

type GqlValue = Record<string, unknown> & { __typename: string };

function wrap(typename: string, fields: Record<string, unknown>): GqlValue {
  return { __typename: typename, ...fields };
}

function userValue(login: string): GqlValue {
  return wrap('User', { login });
}

function repoValue(repo: Repo): GqlValue {
  return wrap('Repository', { repo });
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return wrap('Issue', { repo, issue });
}

function pullValue(repo: Repo, pull: Pull): GqlValue {
  return wrap('PullRequest', { repo, pull });
}

// -------------------------------------------------------------------------------------------
// Introspection data: the field and enum names gh's feature probes read
// -------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'databaseId', 'repository', 'labels', 'assignees', 'milestone', 'stateReason'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'url', 'databaseId', 'repository', 'headRef', 'baseRef', 'isDraft', 'reviewDecision'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'isFork', 'stargazerCount', 'watchers'],
  User: ['login', 'id', 'name', 'email', 'url', 'avatarUrl', 'databaseId'],
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target', 'associatedPullRequests'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

type Resolver = (ex: Executor, parent: GqlValue, args: Record<string, unknown>) => unknown;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

class Executor {
  readonly store: ForgeStore;
  private readonly variables: Record<string, unknown>;
  readonly errors: GqlError[] = [];
  private readonly fragments = new Map<string, FragmentNode>();

  constructor(store: ForgeStore, variables: Record<string, unknown>) {
    this.store = store;
    this.variables = variables;
  }

  run(definitions: DefinitionNode[], operationName: string | undefined): Record<string, unknown> | null {
    for (const def of definitions) {
      if (def.kind === 'fragment') this.fragments.set(def.name, def);
    }
    const operations = definitions.filter((d): d is OperationNode => d.kind === 'operation');
    let operation: OperationNode | undefined;
    if (operationName !== undefined) {
      operation = operations.find((op) => op.name === operationName);
      if (!operation) {
        this.errors.push({ message: `Unknown operation named "${operationName}".` });
        return null;
      }
    } else {
      operation = operations[0];
    }
    if (!operation) {
      this.errors.push({ message: 'No operation in the document.' });
      return null;
    }
    for (const varDef of operation.variables) {
      if (this.variables[varDef.name] === undefined && varDef.defaultValue !== null) {
        this.variables[varDef.name] = this.coerce(varDef.defaultValue);
      }
    }
    const root = wrap(operation.operation === 'mutation' ? 'Mutation' : 'Query', {});
    return this.executeSelectionSet(root, operation.selectionSet, []);
  }

  private coerce(node: ValueNode): unknown {
    switch (node.kind) {
      case 'variable':
        return this.variables[node.name];
      case 'int':
      case 'float':
      case 'string':
      case 'boolean':
        return node.value;
      case 'null':
        return null;
      case 'enum':
        return node.value;
      case 'list':
        return node.values.map((v) => this.coerce(v));
      case 'object': {
        const out: Record<string, unknown> = {};
        for (const f of node.fields) out[f.name] = this.coerce(f.value);
        return out;
      }
    }
  }

  private executeSelectionSet(parent: GqlValue, selections: SelectionNode[], path: Array<string | number>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        const fragment = this.fragments.get(selection.name);
        if (!fragment) {
          this.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
          continue;
        }
        if (fragment.typeCondition !== parent.__typename) continue;
        Object.assign(out, this.executeSelectionSet(parent, fragment.selectionSet, path));
        continue;
      }
      if (selection.kind === 'inline') {
        if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
        Object.assign(out, this.executeSelectionSet(parent, selection.selectionSet, path));
        continue;
      }
      const key = selection.alias ?? selection.name;
      const fieldPath = [...path, key];
      const value = this.resolveField(parent, selection, fieldPath);
      if (value === MISSING) continue;
      out[key] = value;
    }
    return out;
  }

  private resolveField(parent: GqlValue, field: FieldNode, path: Array<string | number>): unknown {
    if (field.name === '__typename') return parent.__typename;
    const table = RESOLVERS[parent.__typename];
    const resolver = table?.[field.name];
    if (!resolver) {
      this.errors.push({
        message: `Cannot query field "${field.name}" on type "${parent.__typename}".`,
        path,
      });
      return MISSING;
    }
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = this.coerce(arg.value);
    let raw: unknown;
    try {
      raw = resolver(this, parent, args);
    } catch (err) {
      this.errors.push({ message: (err as Error).message, path });
      return null;
    }
    if (raw === null || raw === undefined) return null;
    if (field.selectionSet === null) return raw;
    if (Array.isArray(raw)) {
      return raw.map((item, index) => {
        if (item === null || item === undefined) return null;
        if (typeof item === 'object' && '__typename' in (item as object)) {
          return this.executeSelectionSet(item as GqlValue, field.selectionSet!, [...path, index]);
        }
        return item;
      });
    }
    if (typeof raw === 'object' && '__typename' in (raw as object)) {
      return this.executeSelectionSet(raw as GqlValue, field.selectionSet, path);
    }
    return raw;
  }

  // -- global-id lookups used by mutations and node() -------------------------------------------------

  repoByNodeId(id: string): Repo | null {
    const parsed = parseGlobalId(id);
    if (!parsed || parsed.kind !== 'Repository') return null;
    return this.store.reposById.get(Number(parsed.key)) ?? null;
  }

  issueByNodeId(id: string): { repo: Repo; issue: Issue } | null {
    const parsed = parseGlobalId(id);
    if (!parsed || parsed.kind !== 'Issue') return null;
    const [repoId, number] = parsed.key.split(':');
    const repo = this.store.reposById.get(Number(repoId));
    if (!repo) return null;
    const issue = repo.issues.get(Number(number));
    return issue ? { repo, issue } : null;
  }

  pullByNodeId(id: string): { repo: Repo; pull: Pull } | null {
    const parsed = parseGlobalId(id);
    if (!parsed || parsed.kind !== 'PullRequest') return null;
    const [repoId, number] = parsed.key.split(':');
    const repo = this.store.reposById.get(Number(repoId));
    if (!repo) return null;
    const pull = repo.pulls.get(Number(number));
    return pull ? { repo, pull } : null;
  }
}

const MISSING = Symbol('missing');

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userValue(VIEWER_LOGIN),
    repository: (ex, _parent, args) => {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = ex.store.getRepo(owner, name);
      return repo ? repoValue(repo) : null;
    },
    node: (ex, _parent, args) => {
      const id = args.id as string;
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = ex.repoByNodeId(id);
        return repo ? repoValue(repo) : null;
      }
      if (parsed.kind === 'Issue') {
        const found = ex.issueByNodeId(id);
        return found ? issueValue(found.repo, found.issue) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const found = ex.pullByNodeId(id);
        return found ? pullValue(found.repo, found.pull) : null;
      }
      return null;
    },
    __type: (_ex, _parent, args) => {
      const name = args.name as string;
      const fields = SCHEMA_FIELDS[name];
      const enums = SCHEMA_ENUMS[name];
      if (!fields && !enums) return null;
      return wrap('__Type', {
        name,
        kind: enums ? 'ENUM' : 'OBJECT',
        fieldNames: fields ?? [],
        enumNames: enums ?? [],
      });
    },
  },
  Mutation: {
    createIssue: (ex, _parent, args) => {
      const input = asRecord(args.input);
      const repo = ex.repoByNodeId(String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repositoryId does not name a repository');
      const title = String(input.title ?? '');
      if (title === '') throw new Error('title is required');
      const result = ex.store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
      if ('error' in result) throw new Error(result.error);
      return wrap('CreateIssuePayload', { issue: issueValue(repo, result.issue) });
    },
    closeIssue: (ex, _parent, args) => {
      const input = asRecord(args.input);
      const found = ex.issueByNodeId(String(input.issueId ?? ''));
      if (!found) throw new Error('issueId does not name an issue');
      found.issue.state = 'closed';
      found.issue.rev++;
      found.issue.cachedJson = null;
      found.issue.updatedAt = new Date().toISOString();
      return wrap('CloseIssuePayload', { issue: issueValue(found.repo, found.issue) });
    },
    createPullRequest: (ex, _parent, args) => {
      const input = asRecord(args.input);
      const repo = ex.repoByNodeId(String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repositoryId does not name a repository');
      const result = ex.store.createPull(
        repo,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in result) throw new Error(result.error);
      return wrap('CreatePullRequestPayload', { pullRequest: pullValue(repo, result.pull) });
    },
    mergePullRequest: (ex, _parent, args) => {
      const input = asRecord(args.input);
      const found = ex.pullByNodeId(String(input.pullRequestId ?? ''));
      if (!found) throw new Error('pullRequestId does not name a pull request');
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      const result = ex.store.mergePull(found.repo, found.pull, method);
      if ('conflict' in result) throw new Error(`Merge conflict in ${result.conflict}`);
      if ('error' in result) throw new Error(result.error);
      return wrap('MergePullRequestPayload', { pullRequest: pullValue(found.repo, found.pull) });
    },
    addComment: (ex, _parent, args) => {
      const input = asRecord(args.input);
      const found = ex.issueByNodeId(String(input.subjectId ?? ''));
      if (!found) throw new Error('subjectId does not name an issue');
      const comment = ex.store.addComment(found.repo, found.issue.number, String(input.body ?? ''));
      if (!comment) throw new Error('could not add the comment');
      return wrap('AddCommentPayload', {
        commentEdge: wrap('IssueCommentEdge', {
          node: wrap('IssueComment', { id: comment.nodeId, body: comment.body }),
        }),
      });
    },
  },
  Repository: {
    id: (_ex, parent) => (parent.repo as Repo).nodeId,
    databaseId: (_ex, parent) => (parent.repo as Repo).id,
    name: (_ex, parent) => (parent.repo as Repo).name,
    nameWithOwner: (_ex, parent) => {
      const repo = parent.repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    description: (_ex, parent) => (parent.repo as Repo).description,
    isPrivate: (_ex, parent) => (parent.repo as Repo).isPrivate,
    owner: (_ex, parent) => userValue((parent.repo as Repo).owner),
    defaultBranchRef: (ex, parent) => {
      const repo = parent.repo as Repo;
      const tip = ex.store.branchTip(repo, repo.defaultBranch);
      return tip === null ? null : wrap('Ref', { name: repo.defaultBranch });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (_ex, parent, args) => {
      const repo = parent.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueValue(repo, issue) : null;
    },
    issues: (_ex, parent, args) => {
      const repo = parent.repo as Repo;
      let list = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = asRecord(args.orderBy);
      const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
      list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      const after = args.after;
      if (typeof after === 'string' && after !== '') {
        const cursorNumber = decodeCursor(after);
        if (cursorNumber !== null) {
          const index = list.findIndex((i) => i.number === cursorNumber);
          if (index >= 0) list = list.slice(index + 1);
        }
      }
      const first = typeof args.first === 'number' ? args.first : 30;
      const page = list.slice(0, Math.max(0, first));
      const hasNextPage = list.length > page.length;
      const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
      return wrap('IssueConnection', {
        nodes: page.map((i) => issueValue(repo, i)),
        pageInfo: wrap('PageInfo', { hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor(page[0].number) : null }),
      });
    },
    pullRequests: (_ex, parent, args) => {
      const repo = parent.repo as Repo;
      let list = [...repo.pulls.values()].filter((p) => p.state === 'open');
      list.sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' ? args.first : 30;
      const page = list.slice(0, Math.max(0, first));
      return wrap('PullRequestConnection', {
        nodes: page.map((p) => pullValue(repo, p)),
        pageInfo: wrap('PageInfo', { hasNextPage: list.length > page.length, endCursor: null, hasPreviousPage: false, startCursor: null }),
      });
    },
    pullRequest: (_ex, parent, args) => {
      const repo = parent.repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullValue(repo, pull) : null;
    },
  },
  User: {
    login: (_ex, parent) => String(parent.login),
    id: () => 1000,
    name: () => 'ada iversen',
    email: () => 'adaiversen@example.invalid',
  },
  Issue: {
    id: (_ex, parent) => (parent.issue as Issue).nodeId,
    number: (_ex, parent) => (parent.issue as Issue).number,
    title: (_ex, parent) => (parent.issue as Issue).title,
    state: (_ex, parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (_ex, parent) => (parent.issue as Issue).body,
  },
  IssueConnection: {
    nodes: (_ex, parent) => parent.nodes as unknown[],
    pageInfo: (_ex, parent) => parent.pageInfo as GqlValue,
    totalCount: (_ex, parent) => (parent.nodes as unknown[]).length,
  },
  PageInfo: {
    hasNextPage: (_ex, parent) => parent.hasNextPage as boolean,
    hasPreviousPage: (_ex, parent) => parent.hasPreviousPage as boolean,
    startCursor: (_ex, parent) => parent.startCursor as string | null,
    endCursor: (_ex, parent) => parent.endCursor as string | null,
  },
  PullRequest: {
    id: (_ex, parent) => (parent.pull as Pull).nodeId,
    number: (_ex, parent) => (parent.pull as Pull).number,
    title: (_ex, parent) => (parent.pull as Pull).title,
    body: (_ex, parent) => (parent.pull as Pull).body,
    state: (_ex, parent) => {
      const pull = parent.pull as Pull;
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (_ex, parent) => (parent.pull as Pull).merged,
    headRefName: (_ex, parent) => (parent.pull as Pull).headRef,
    baseRefName: (_ex, parent) => (parent.pull as Pull).baseRef,
    mergeable: (ex, parent) => ex.store.pullMergeable(parent.repo as Repo, parent.pull as Pull),
    files: (ex, parent, args) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      const files = ex.store.pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : 30;
      const page = files.slice(0, Math.max(0, first));
      return wrap('PullRequestChangedFileConnection', {
        nodes: page.map((f) => wrap('PullRequestChangedFile', { path: f.path })),
        pageInfo: wrap('PageInfo', { hasNextPage: files.length > page.length, endCursor: null, hasPreviousPage: false, startCursor: null }),
      });
    },
  },
  PullRequestConnection: {
    nodes: (_ex, parent) => parent.nodes as unknown[],
    pageInfo: (_ex, parent) => parent.pageInfo as GqlValue,
    totalCount: (_ex, parent) => (parent.nodes as unknown[]).length,
  },
  PullRequestChangedFileConnection: {
    nodes: (_ex, parent) => parent.nodes as unknown[],
    pageInfo: (_ex, parent) => parent.pageInfo as GqlValue,
  },
  PullRequestChangedFile: {
    path: (_ex, parent) => parent.path as string,
  },
  Ref: {
    name: (_ex, parent) => parent.name as string,
  },
  CreateIssuePayload: {
    issue: (_ex, parent) => parent.issue as GqlValue,
  },
  CloseIssuePayload: {
    issue: (_ex, parent) => parent.issue as GqlValue,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ex, parent) => parent.pullRequest as GqlValue,
  },
  MergePullRequestPayload: {
    pullRequest: (_ex, parent) => parent.pullRequest as GqlValue,
  },
  AddCommentPayload: {
    commentEdge: (_ex, parent) => parent.commentEdge as GqlValue,
  },
  IssueCommentEdge: {
    node: (_ex, parent) => parent.node as GqlValue,
  },
  IssueComment: {
    id: (_ex, parent) => parent.id as string,
    body: (_ex, parent) => parent.body as string,
  },
  __Type: {
    name: (_ex, parent) => parent.name as string,
    kind: (_ex, parent) => parent.kind as string,
    fields: (_ex, parent) => (parent.fieldNames as string[]).map((name) => wrap('__Field', { name })),
    enumValues: (_ex, parent) => (parent.enumNames as string[]).map((name) => wrap('__EnumValue', { name })),
  },
  __Field: {
    name: (_ex, parent) => parent.name as string,
  },
  __EnumValue: {
    name: (_ex, parent) => parent.name as string,
  },
};

// -------------------------------------------------------------------------------------------
// The endpoint
// -------------------------------------------------------------------------------------------

function executeOne(
  store: ForgeStore,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'The request body must carry a query string.' }] };
  }
  const variables = asRecord(body.variables);
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
  }
  const executor = new Executor(store, { ...variables });
  const data = executor.run(definitions, operationName);
  const out: Record<string, unknown> = { data };
  if (executor.errors.length > 0) out.errors = executor.errors;
  return out;
}

export function handleGraphQL(ctx: RequestCtx): Reply {
  if (ctx.method !== 'POST') return errorReply(405, 'GraphQL requires POST');
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonReply(400, { errors: [{ message: 'The request body is not valid JSON.' }] });
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      entry !== null && typeof entry === 'object' ? executeOne(ctx.store, entry as Record<string, unknown>) : { data: null, errors: [{ message: 'A batched entry must be an object.' }] },
    );
    return jsonReply(200, results);
  }
  if (parsed !== null && typeof parsed === 'object') {
    return jsonReply(200, executeOne(ctx.store, parsed as Record<string, unknown>));
  }
  return jsonReply(400, { errors: [{ message: 'The request body must be a JSON object or array.' }] });
}
