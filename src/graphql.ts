// src/graphql.ts — GitHub GraphQL v4 at POST /api/graphql.
//
// A small executor for the documents gh and github-mcp-server actually send:
// viewer/repository reads, __type introspection, issue and pull-request
// connections (with states/orderBy/cursor pagination), the create/close/
// merge/addComment mutations, node(id:) and operation batching (a JSON
// array of documents answers an array of results, in order).
//
// An unauthenticated request is exactly 401. A query naming an unknown
// field is HTTP 200 with an errors array naming it. An unknown repository
// is data.repository = null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorized } from './auth.ts';
import {
  branchTip,
  decodeGlobalId,
  forge,
  globalId,
  nowIso,
  pullFiles,
  pullMergeable,
  squashMerge,
} from './store.ts';
import type { Issue, PullRequest, Repo } from './store.ts';
import { isRecord, originOf, parseJsonBody, readBody, sendError, sendJson } from './http.ts';

// ---------------------------------------------------------------------------
// Introspection schema (what __type must describe)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'url', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'mergedAt', 'mergeCommit',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  User: ['id', 'login', 'name', 'avatarUrl', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// Tokenizer + parser for the GraphQL document subset the clients send
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'punct';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    // Unknown character: skip it rather than failing the whole document.
    i += 1;
  }
  return tokens;
}

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: SelectionNode[] | null;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

export type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

export interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

export interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;

  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token === undefined || token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}`);
    }
  }

  skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && maybeName.kind === 'name') {
          name = maybeName.value;
          this.next();
        }
        this.skipVariableDefinitions();
        operations.push({ kind: token.value as 'query' | 'mutation', name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const nameToken = this.next();
        const onToken = this.next();
        const typeToken = this.next();
        if (nameToken === undefined || onToken === undefined || typeToken === undefined) throw new Error('bad fragment');
        fragments.set(nameToken.value, {
          name: nameToken.value,
          typeCondition: typeToken.value,
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      // Unrecognised top-level token: skip it.
      this.next();
    }
    return { operations, fragments };
  }

  /** Skip ($var: Type = default, ...) variable definitions. */
  skipVariableDefinitions(): void {
    if (!this.skipPunct('(')) return;
    let depth = 1;
    while (this.pos < this.tokens.length && depth > 0) {
      const token = this.next() as Token;
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeToken = this.next();
          selections.push({ kind: 'inline', typeCondition: typeToken?.value ?? null, selections: this.parseSelectionSet() });
        } else if (next !== undefined && next.kind === 'name') {
          this.next();
          selections.push({ kind: 'spread', name: next.value });
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() });
        }
        continue;
      }
      if (token.kind === 'name') {
        selections.push(this.parseField());
        continue;
      }
      this.next();
    }
    return selections;
  }

  parseField(): FieldNode {
    const first = this.next() as Token;
    let alias: string | null = null;
    let name = first.value;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = (this.next() as Token).value;
    }
    const args: Record<string, unknown> = {};
    if (this.skipPunct('(')) {
      while (this.peek() !== undefined) {
        const token = this.peek() as Token;
        if (token.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        if (token.kind === 'name') {
          this.next();
          this.expectPunct(':');
          args[token.value] = this.parseValue();
          continue;
        }
        this.next();
      }
    }
    // Directives (@include/@skip/...): skip them.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      const directive = this.next();
      void directive;
      if (this.skipPunct('(')) {
        let depth = 1;
        while (this.pos < this.tokens.length && depth > 0) {
          const t = this.next() as Token;
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): unknown {
    const token = this.next();
    if (token === undefined) return null;
    if (token.kind === 'punct' && token.value === '$') {
      const nameToken = this.next();
      if (nameToken === undefined) return null;
      return this.variables[nameToken.value] ?? null;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') {
      const n = Number(token.value);
      return Number.isFinite(n) ? n : token.value;
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (this.peek() !== undefined) {
        const t = this.peek() as Token;
        if (t.kind === 'punct' && t.value === ']') {
          this.next();
          break;
        }
        items.push(this.parseValue());
      }
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== undefined) {
        const t = this.peek() as Token;
        if (t.kind === 'punct' && t.value === '}') {
          this.next();
          break;
        }
        if (t.kind === 'name') {
          this.next();
          this.expectPunct(':');
          obj[t.value] = this.parseValue();
          continue;
        }
        this.next();
      }
      return obj;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum value: its name as a string
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown>;

interface ExecContext {
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
  base: string;
}

function repoOfId(databaseId: number): Repo | undefined {
  for (const repo of forge.listRepos()) if (repo.id === databaseId) return repo;
  return undefined;
}

function issueObject(repo: Repo, issue: Issue): AnyObj {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: PullRequest): AnyObj {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: globalId('pr', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    mergedAt: pull.merged_at,
    url: `/api/v3/repos/${repo.full_name}/pull/${pull.number}`,
  };
}

function repoObject(repo: Repo): AnyObj {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: globalId('repo', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    description: repo.description,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.private,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    url: `/api/v3/repos/${repo.full_name}`,
  };
}

function userObject(): AnyObj {
  return {
    __typename: 'User',
    id: globalId('user', 1000),
    login: 'adaiversen',
    name: 'ada iversen',
    avatarUrl: '',
    url: '/adaiversen',
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(after: unknown): number | null {
  if (typeof after !== 'string' || after === '') return null;
  try {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    if (!text.startsWith('issue:')) return null;
    const n = Number.parseInt(text.slice('issue:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>): AnyObj {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const field = orderBy !== null ? String(orderBy.field ?? 'CREATED_AT') : 'CREATED_AT';
  const direction = orderBy !== null ? String(orderBy.direction ?? 'ASC') : 'ASC';
  const dir = direction === 'DESC' ? -1 : 1;
  void field; // CREATED_AT and UPDATED_AT both order by creation sequence here
  issues.sort((a, b) => (a.seq - b.seq) * dir);
  const afterNum = cursorNumber(args.after);
  if (afterNum !== null) {
    const idx = issues.findIndex((issue) => issue.number === afterNum);
    if (idx >= 0) issues = issues.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const total = issues.length;
  const page = issues.slice(0, Math.max(0, first));
  const hasNextPage = total > page.length;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(repo, issue)),
    totalCount: total,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor((page[0] as Issue).number) : null,
      endCursor,
    },
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): AnyObj {
  const pulls = [...repo.pulls].sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, Math.max(0, first));
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(repo, pull)),
    totalCount: pulls.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: pulls.length > page.length,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
  };
}

function introspectionObject(name: string): AnyObj | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      fields: (TYPE_FIELDS[name] as string[]).map((field) => ({ __typename: '__Field', name: field })),
      enumValues: null,
    };
  }
  if (ENUM_VALUES[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: (ENUM_VALUES[name] as string[]).map((value) => ({ __typename: '__EnumValue', name: value })),
    };
  }
  return null;
}

/** Resolve one field of a parent object. */
function resolveField(ctx: ExecContext, parent: AnyObj, typeName: string, field: FieldNode): unknown {
  const name = field.name;
  const args = field.args;

  if (typeName === 'Query') {
    if (name === 'viewer') return userObject();
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      if (owner !== 'adaiversen') return null;
      const repo = forge.getRepo(owner, repoName);
      return repo === undefined ? null : repoObject(repo);
    }
    if (name === 'node') {
      const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
      if (decoded === null) return null;
      if (decoded.kind === 'repo' && decoded.parts[0] !== undefined) {
        const repo = repoOfId(decoded.parts[0]);
        return repo === undefined ? null : repoObject(repo);
      }
      if (decoded.kind === 'issue' && decoded.parts[0] !== undefined && decoded.parts[1] !== undefined) {
        const repo = repoOfId(decoded.parts[0]);
        const issue = repo === undefined ? undefined : forge.findIssue(repo, decoded.parts[1]);
        return repo === undefined || issue === undefined ? null : issueObject(repo, issue);
      }
      if (decoded.kind === 'pr' && decoded.parts[0] !== undefined && decoded.parts[1] !== undefined) {
        const repo = repoOfId(decoded.parts[0]);
        const pull = repo === undefined ? undefined : forge.findPull(repo, decoded.parts[1]);
        return repo === undefined || pull === undefined ? null : pullObject(repo, pull);
      }
      return null;
    }
    if (name === '__type') {
      const typeNameArg = String(args.name ?? '');
      return introspectionObject(typeNameArg);
    }
    if (name === '__schema') {
      return {
        __typename: '__Schema',
        queryType: { __typename: '__Type', name: 'Query' },
        mutationType: { __typename: '__Type', name: 'Mutation' },
        types: Object.keys(TYPE_FIELDS).map((type) => ({ __typename: '__Type', name: type })),
      };
    }
    return undefined;
  }

  if (typeName === 'Mutation') {
    if (name === 'createIssue') {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.kind === 'repo' && decoded.parts[0] !== undefined ? repoOfId(decoded.parts[0]) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'createIssue: repository not found' });
        return null;
      }
      const issue = forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: null };
    }
    if (name === 'closeIssue') {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const repo = decoded !== null && decoded.kind === 'issue' && decoded.parts[0] !== undefined ? repoOfId(decoded.parts[0]) : undefined;
      const issue = repo !== undefined && decoded !== null && decoded.parts[1] !== undefined ? forge.findIssue(repo, decoded.parts[1]) : undefined;
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'closeIssue: issue not found' });
        return null;
      }
      issue.state = 'closed';
      issue.updated_at = nowIso();
      return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue), clientMutationId: null };
    }
    if (name === 'createPullRequest') {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.kind === 'repo' && decoded.parts[0] !== undefined ? repoOfId(decoded.parts[0]) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'createPullRequest: repository not found' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? repo.default_branch);
      if (branchTip(repo.git, head) === undefined || branchTip(repo.git, baseRef) === undefined) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        return null;
      }
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head.ref === head && pull.base.ref === baseRef);
      if (duplicate !== undefined) {
        ctx.errors.push({ message: 'createPullRequest: a pull request already exists for this head branch' });
        return null;
      }
      const pull = forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, baseRef);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: null };
    }
    if (name === 'mergePullRequest') {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const repo = decoded !== null && decoded.kind === 'pr' && decoded.parts[0] !== undefined ? repoOfId(decoded.parts[0]) : undefined;
      const pull = repo !== undefined && decoded !== null && decoded.parts[1] !== undefined ? forge.findPull(repo, decoded.parts[1]) : undefined;
      if (repo === undefined || pull === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
        return null;
      }
      if (!pullMergeable(repo, pull)) {
        ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
        return null;
      }
      const merged = squashMerge(repo, pull);
      if (!merged.ok) {
        ctx.errors.push({ message: `mergePullRequest: ${merged.reason}` });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: null };
    }
    if (name === 'addComment') {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const repo = decoded !== null && decoded.kind === 'issue' && decoded.parts[0] !== undefined ? repoOfId(decoded.parts[0]) : undefined;
      const issue = repo !== undefined && decoded !== null && decoded.parts[1] !== undefined ? forge.findIssue(repo, decoded.parts[1]) : undefined;
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'addComment: subject not found' });
        return null;
      }
      const comment = forge.createComment(repo, issue, String(input.body ?? ''));
      const node: AnyObj = {
        __typename: 'IssueComment',
        id: globalId('comment', repo.id, issue.number, comment.id),
        body: comment.body,
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node },
        comment: node,
        clientMutationId: null,
      };
    }
    return undefined;
  }

  if (typeName === 'Repository') {
    const repo = parent.__repo as Repo;
    if (name === 'owner') return userObject();
    if (name === 'defaultBranchRef') {
      const tip = branchTip(repo.git, repo.default_branch);
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.default_branch, target: { __typename: 'Commit', oid: tip } };
    }
    if (name === 'issue') {
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = forge.findIssue(repo, number);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    if (name === 'issues') return issueConnection(repo, args);
    if (name === 'pullRequests') return pullConnection(repo, args);
    if (name === 'pullRequest') {
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = forge.findPull(repo, number);
      return pull === undefined ? null : pullObject(repo, pull);
    }
    if (name === 'id' || name === 'databaseId' || name === 'name' || name === 'nameWithOwner' || name === 'description' || name === 'viewerPermission' || name === 'hasIssuesEnabled' || name === 'isPrivate' || name === 'createdAt' || name === 'updatedAt' || name === 'url') {
      return parent[name];
    }
    return undefined;
  }

  if (typeName === 'Issue') {
    const repo = parent.__repo as Repo;
    const issue = parent.__issue as Issue;
    if (name === 'author') return userObject();
    if (name === 'labels') {
      return { __typename: 'LabelConnection', nodes: issue.labels.map((label) => ({ __typename: 'Label', name: label.name, color: label.color })) };
    }
    if (name === 'comments') {
      return { __typename: 'IssueCommentConnection', nodes: issue.comments.map((c) => ({ __typename: 'IssueComment', id: globalId('comment', repo.id, issue.number, c.id), body: c.body })) };
    }
    if (name === 'id' || name === 'number' || name === 'title' || name === 'state' || name === 'body' || name === 'createdAt' || name === 'updatedAt' || name === 'url') {
      return parent[name];
    }
    return undefined;
  }

  if (typeName === 'PullRequest') {
    const repo = parent.__repo as Repo;
    const pull = parent.__pull as PullRequest;
    if (name === 'author') return userObject();
    if (name === 'headRef') return { __typename: 'Ref', name: pull.head.ref };
    if (name === 'baseRef') return { __typename: 'Ref', name: pull.base.ref };
    if (name === 'mergeCommit') {
      return pull.merge_commit_sha === null ? null : { __typename: 'Commit', oid: pull.merge_commit_sha };
    }
    if (name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 100;
      const changes = pullFiles(repo, pull).slice(0, Math.max(0, first));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: changes.map((change) => ({
          __typename: 'PullRequestChangedFile',
          path: change.path,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status.toUpperCase(),
        })),
        totalCount: pullFiles(repo, pull).length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    if (name === 'id' || name === 'number' || name === 'title' || name === 'body' || name === 'state' || name === 'merged' || name === 'mergeable' || name === 'headRefName' || name === 'baseRefName' || name === 'createdAt' || name === 'updatedAt' || name === 'mergedAt' || name === 'url') {
      return parent[name];
    }
    return undefined;
  }

  // Generic object types: fields are plain properties of the parent.
  if (name in parent) return parent[name];
  return undefined;
}

/** Execute a selection set against a parent object of a given type name. */
function executeSelections(ctx: ExecContext, parent: AnyObj, typeName: string, selections: SelectionNode[]): AnyObj {
  const out: AnyObj = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) {
        const sub = executeSelections(ctx, parent, typeName, fragment.selections);
        Object.assign(out, sub);
      }
      continue;
    }
    if (selection.kind === 'inline') {
      const parentType = typeof parent.__typename === 'string' ? (parent.__typename as string) : typeName;
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      const sub = executeSelections(ctx, parent, typeName, selection.selections);
      Object.assign(out, sub);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(ctx, parent, typeName, selection);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    if (value === null || selection.selections === null) {
      out[key] = value;
      continue;
    }
    out[key] = resolveValue(ctx, value, selection.selections);
  }
  return out;
}

function typeNameOf(value: AnyObj): string {
  if (typeof value.__typename === 'string') return value.__typename as string;
  return 'Object';
}

/** Resolve a field value that carries its own sub-selections. */
function resolveValue(ctx: ExecContext, value: unknown, selections: SelectionNode[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveValue(ctx, entry, selections));
  if (isRecord(value)) return executeSelections(ctx, value, typeNameOf(value), selections);
  return value;
}

function executeDocument(query: string, variables: Record<string, unknown>, operationName: string | undefined, base: string): { data: AnyObj | null; errors?: { message: string }[] } {
  const ctx: ExecContext = { fragments: new Map(), errors: [], base };
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(tokenize(query), variables).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  ctx.fragments = parsed.fragments;
  let operation = parsed.operations[0];
  if (operationName !== undefined) {
    const named = parsed.operations.find((op) => op.name === operationName);
    if (named !== undefined) operation = named;
  }
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation provided' }] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, { __typename: rootType }, rootType, operation.selections);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle one POST /api/graphql request. */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  if (raw === null) {
    sendError(res, 400, 'Request body too large');
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  const base = originOf(req);
  const body = parsed.value;
  // Operation batching: a JSON array of documents answers an array of results.
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
      const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
      return executeDocument(entry.query, variables, typeof entry.operationName === 'string' ? entry.operationName : undefined, base);
    });
    sendJson(res, 200, results);
    return;
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    sendError(res, 400, 'query is required');
    return;
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const result = executeDocument(body.query, variables, typeof body.operationName === 'string' ? body.operationName : undefined, base);
  sendJson(res, 200, result);
}
