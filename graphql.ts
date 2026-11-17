// GraphQL v4 at /api/graphql: a hand-written lexer, parser and executor covering the document
// shapes the suite sends (viewer, repository fields, issue/pull connections with cursor
// pagination, search, node, introspection of the tested types, and the five mutations). Global
// ids are opaque base64 strings with a type prefix; they are stable for the life of the store
// and are never the plain database id or number.

import {
  DomainError,
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
  pullFiles,
  type RestResult,
} from './rest.ts';
import {
  Store,
  getCommit,
  mergedTreeOf,
  type IssueRec,
  type RepoRec,
} from './store.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      const raw = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(raw) } : { kind: 'int', value: Number.parseInt(raw, 10) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyMap<string, ValueNode> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyMap<string, ValueNode>;
  readonly selectionSet: readonly SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { readonly kind: 'inline'; readonly typeCondition: string | null; readonly selectionSet: readonly SelectionNode[] }
  | { readonly kind: 'spread'; readonly name: string };

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selectionSet: readonly SelectionNode[];
}

interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: ReadonlyMap<string, { typeCondition: string; selectionSet: readonly SelectionNode[] }>;
}

class Parser {
  private at = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.at] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.at] as Token;
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: readonly SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation or fragment');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = (this.next() as { value: string }).value;
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('fragment needs a name');
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('fragment needs "on"');
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('fragment needs a type condition');
        this.skipDirectives();
        fragments.set(nameToken.value, { typeCondition: typeToken.value, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.next();
      if (name.kind !== 'name') throw new Error('variable needs a name');
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      const token = this.next();
      if (token.kind !== 'name') throw new Error('type needs a name');
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      const token = this.next();
      if (token.kind !== 'name') throw new Error('directive needs a name');
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('argument needs a name');
      this.expectPunct(':');
      args.set(name.value, this.parseValue());
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('variable needs a name');
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!this.skipPunct('}')) {
        const name = this.next();
        if (name.kind !== 'name') throw new Error('object field needs a name');
        this.expectPunct(':');
        fields.set(name.value, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeToken = this.next();
          if (typeToken.kind !== 'name') throw new Error('inline fragment needs a type');
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: typeToken.value, selectionSet: this.parseSelectionSet() });
        } else if (next.kind === 'name') {
          this.next();
          this.skipDirectives();
          selections.push({ kind: 'spread', name: next.value });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      if (token.kind !== 'name') throw new Error('selection needs a field name');
      this.next();
      let alias: string | null = null;
      let name = token.value;
      if (this.skipPunct(':')) {
        alias = name;
        const real = this.next();
        if (real.kind !== 'name') throw new Error('field alias needs a field name');
        name = real.value;
      }
      let args = new Map<string, ValueNode>();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') args = this.parseArguments();
      this.skipDirectives();
      let selectionSet: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    return selections;
  }
}

// ---------------------------------------------------------------- values and ids

type Variables = Readonly<Record<string, unknown>>;

function evalValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
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
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = evalValue(value, variables);
  return out;
}

const encodeId = (raw: string): string => Buffer.from(raw, 'utf8').toString('base64');
export const repoGlobalId = (repo: RepoRec): string => encodeId(`R_${repo.id}`);
export const issueGlobalId = (repo: RepoRec, issue: IssueRec): string => encodeId(issue.isPull ? `PR_${repo.id}_${issue.number}` : `I_${repo.id}_${issue.number}`);
export const commentGlobalId = (repo: RepoRec, issue: IssueRec, commentId: number): string => encodeId(`C_${repo.id}_${issue.number}_${commentId}`);
export const userGlobalId = (): string => encodeId('U_1');

function decodeId(id: string): string {
  try {
    return Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- execution

interface Ctx {
  readonly store: Store;
  readonly variables: Variables;
  readonly fragments: DocumentNode['fragments'];
  readonly errors: { message: string }[];
}

type GqlValue = Record<string, unknown> & { __type: string };

const typed = (type: string, fields: Record<string, unknown>): GqlValue => ({ __type: type, ...fields });

function userValue(store: Store): GqlValue {
  return typed('User', { login: store.viewerLogin ?? '' });
}

function repoValue(repo: RepoRec): GqlValue {
  return typed('Repository', { repo });
}

function issueValue(repo: RepoRec, issue: IssueRec): GqlValue {
  return typed(issue.isPull ? 'PullRequest' : 'Issue', { repo, issue });
}

interface Connection {
  readonly items: readonly GqlValue[];
  readonly totalCount: number;
}

function connectionValue(kind: string, connection: Connection): GqlValue {
  return typed(kind, { items: connection.items, totalCount: connection.totalCount });
}

const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');

function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  const raw = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^cursor:(\d+)$/.exec(raw);
  return match === null ? -1 : Number(match[1]);
}

/** Slice a connection's items by first/after, GitHub-cursor style. */
function pageOf(items: readonly GqlValue[], args: Record<string, unknown>): { nodes: GqlValue[]; edges: { node: GqlValue; cursor: string }[]; pageInfo: GqlValue } {
  const after = cursorIndex(args.after);
  const start = after >= 0 ? after + 1 : 0;
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : items.length;
  const slice = items.slice(start, start + first);
  const edges = slice.map((node, i) => ({ node, cursor: cursorOf(start + i) }));
  return {
    nodes: slice,
    edges,
    pageInfo: typed('PageInfo', {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
    }),
  };
}

class FieldProblem extends Error {}

function unknownField(typeName: string, field: string): FieldProblem {
  return new FieldProblem(`Field '${field}' is not defined by type '${typeName}'`);
}

// The static schema the introspection checks read.
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'databaseId', 'name', 'url', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'closed', 'author', 'url',
    'createdAt', 'updatedAt', 'labels', 'comments', 'repository',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'author', 'url',
    'createdAt', 'updatedAt', 'files', 'comments', 'repository',
  ],
  Label: ['id', 'name', 'color'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Ref: ['name', 'prefix', 'target'],
  GitObject: ['oid', 'abbreviatedOid'],
  Commit: ['oid', 'message', 'tree'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'issueCount', 'repositoryCount', 'userCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestFilesConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  SearchResultItemEdge: ['node', 'cursor'],
  __Schema: ['queryType', 'mutationType', 'types'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

function typeInfo(name: string): GqlValue {
  const fields = TYPE_FIELDS[name];
  const enums = ENUM_VALUES[name];
  const kind = enums !== undefined ? 'ENUM' : fields !== undefined ? 'OBJECT' : ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name) ? 'SCALAR' : 'OBJECT';
  return typed('__Type', {
    name,
    kind,
    fieldNames: fields ?? [],
    enumNames: enums ?? [],
  });
}

function resolveField(ctx: Ctx, typeName: string, source: GqlValue, field: FieldNode): unknown {
  const args = argsOf(field, ctx.variables);
  const store = ctx.store;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return userValue(store);
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = store.repo(owner, name);
        return repo === null ? null : repoValue(repo);
      }
      if (field.name === 'node') return nodeById(ctx, String(args.id ?? ''));
      if (field.name === 'search') return searchValue(ctx, args);
      if (field.name === '__type') return typeInfo(String(args.name ?? ''));
      if (field.name === '__schema') {
        return typed('__Schema', {});
      }
      if (field.name === 'rateLimit') return typed('RateLimit', { limit: 5000, cost: 1, remaining: 5000, used: 0, resetAt: null });
      break;
    }
    case 'Mutation': {
      return resolveMutation(ctx, field.name, args);
    }
    case 'User': {
      if (field.name === 'login') return source.login as string;
      if (field.name === 'id') return userGlobalId();
      if (field.name === 'databaseId') return 1;
      if (field.name === 'name') return source.login as string;
      if (field.name === 'url') return `https://forge.local/${source.login as string}`;
      if (field.name === 'email') return '';
      break;
    }
    case 'Repository': {
      return resolveRepository(ctx, source.repo as RepoRec, field.name, args);
    }
    case 'Issue':
    case 'PullRequest': {
      return resolveIssue(ctx, source.repo as RepoRec, source.issue as IssueRec, field.name, args);
    }
    case 'Label': {
      if (field.name === 'name') return source.name as string;
      if (field.name === 'id') return encodeId(`L_${source.name as string}`);
      if (field.name === 'color') return 'ededed';
      break;
    }
    case 'Comment':
    case 'IssueComment': {
      if (field.name === 'id') return commentGlobalId(source.repo as RepoRec, source.issue as IssueRec, (source.comment as { id: number }).id);
      if (field.name === 'body') return (source.comment as { body: string }).body;
      if (field.name === 'author') return userValue(store);
      if (field.name === 'createdAt') return new Date(1_700_000_000_000).toISOString();
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return source.name as string;
      if (field.name === 'prefix') return 'refs/heads/';
      if (field.name === 'target') return typed('GitObject', { oid: source.oid as string });
      break;
    }
    case 'GitObject':
    case 'Commit': {
      if (field.name === 'oid') return source.oid as string;
      if (field.name === 'abbreviatedOid') return (source.oid as string).slice(0, 7);
      break;
    }
    case 'PageInfo': {
      if (field.name in source) return source[field.name];
      break;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return source.path as string;
      if (field.name === 'additions') return source.additions as number;
      if (field.name === 'deletions') return source.deletions as number;
      if (field.name === 'changeType') return source.changeType as string;
      break;
    }
    case 'RateLimit': {
      if (field.name in source) return source[field.name];
      break;
    }
    case '__Schema': {
      if (field.name === 'queryType') return typeInfo('Query');
      if (field.name === 'mutationType') return typeInfo('Mutation');
      if (field.name === 'types') return Object.keys(TYPE_FIELDS).map((name) => typeInfo(name));
      break;
    }
    case '__Type': {
      if (field.name === 'name') return source.name as string;
      if (field.name === 'kind') return source.kind as string;
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        return (source.fieldNames as readonly string[]).map((name) => typed('__Field', { name }));
      }
      if (field.name === 'enumValues') {
        return (source.enumNames as readonly string[]).map((name) => typed('__EnumValue', { name }));
      }
      if (field.name === 'possibleTypes') return [];
      if (field.name === 'inputFields') return [];
      if (field.name === 'ofType') return null;
      break;
    }
    case '__Field': {
      if (field.name === 'name') return source.name as string;
      if (field.name === 'description') return null;
      if (field.name === 'args') return [];
      if (field.name === 'type') return typeInfo('String');
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      break;
    }
    case '__EnumValue': {
      if (field.name === 'name') return source.name as string;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      break;
    }
    default: {
      // Connection and payload shapes resolve generically below.
      if (typeName.endsWith('Connection')) return resolveConnection(ctx, source, field.name, args);
      if (typeName.endsWith('Payload')) {
        if (field.name === 'clientMutationId') return source.clientMutationId ?? null;
        if (field.name in source) return source[field.name];
      }
      if (typeName.endsWith('Edge')) {
        if (field.name === 'node') return source.node as GqlValue;
        if (field.name === 'cursor') return source.cursor as string;
      }
    }
  }
  throw unknownField(typeName, field.name);
}

function resolveConnection(ctx: Ctx, source: GqlValue, fieldName: string, args: Record<string, unknown>): unknown {
  void ctx;
  void args;
  const items = source.items as readonly GqlValue[];
  const pageArgs = (source.pageArgs as Record<string, unknown> | undefined) ?? {};
  if (fieldName === 'nodes') return [...pageOf(items, pageArgs).nodes];
  if (fieldName === 'edges') return pageOf(items, pageArgs).edges.map((edge) => typed('Edge', edge));
  if (fieldName === 'pageInfo') return pageOf(items, pageArgs).pageInfo;
  if (fieldName === 'totalCount') return source.totalCount as number;
  if (fieldName === 'issueCount') return source.issueCount as number;
  if (fieldName === 'repositoryCount') return 0;
  if (fieldName === 'userCount') return 0;
  throw unknownField(String(source.__type), fieldName);
}

function resolveRepository(ctx: Ctx, repo: RepoRec, fieldName: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  switch (fieldName) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${store.viewerLogin ?? ''}/${repo.name}`;
    case 'owner':
      return userValue(store);
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.isPrivate;
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return typed('Ref', { name: repo.defaultBranch, oid: tip ?? '' });
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'hasWikiEnabled':
      return false;
    case 'url':
      return `https://forge.local/${store.viewerLogin ?? ''}/${repo.name}`;
    case 'createdAt':
    case 'updatedAt':
      return new Date(repo.createdAtSec * 1000).toISOString();
    case 'issue': {
      const record = repo.issues.get(Number(args.number));
      if (record === undefined || record.isPull) return null;
      return issueValue(repo, record);
    }
    case 'pullRequest': {
      const record = repo.issues.get(Number(args.number));
      if (record === undefined || !record.isPull) return null;
      return issueValue(repo, record);
    }
    case 'issues': {
      const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
      let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
      list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const descending = orderBy?.direction === 'DESC';
      list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      const items = list.map((issue) => issueValue(repo, issue));
      const value = connectionValue('IssueConnection', { items, totalCount: items.length });
      value.pageArgs = args;
      return value;
    }
    case 'pullRequests': {
      const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
      let list = [...repo.issues.values()].filter((issue) => issue.isPull);
      list = list.filter((issue) => states.includes(issue.merged ? 'MERGED' : issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
      const descending = orderBy?.direction === 'DESC';
      list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      const items = list.map((issue) => issueValue(repo, issue));
      const value = connectionValue('PullRequestConnection', { items, totalCount: items.length });
      value.pageArgs = args;
      return value;
    }
    default:
      throw unknownField('Repository', fieldName);
  }
}

function resolveIssue(ctx: Ctx, repo: RepoRec, issue: IssueRec, fieldName: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  switch (fieldName) {
    case 'id':
      return issueGlobalId(repo, issue);
    case 'databaseId':
      return repo.id * 1_000_000 + issue.number;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.isPull && issue.merged ? 'MERGED' : issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'closed':
      return issue.state === 'closed';
    case 'merged':
      return issue.merged;
    case 'mergedAt':
      return issue.merged && issue.mergedAtSec !== null ? new Date(issue.mergedAtSec * 1000).toISOString() : null;
    case 'mergeCommit':
      return issue.mergeCommitSha === null ? null : typed('Commit', { oid: issue.mergeCommitSha });
    case 'headRefName':
      return issue.headRef;
    case 'baseRefName':
      return issue.baseRef;
    case 'headRefOid':
      return repo.refs.get(`refs/heads/${issue.headRef}`) ?? null;
    case 'baseRefOid':
      return repo.refs.get(`refs/heads/${issue.baseRef}`) ?? null;
    case 'mergeable': {
      if (issue.merged || issue.state === 'closed') return 'UNKNOWN';
      const headTip = repo.refs.get(`refs/heads/${issue.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${issue.baseRef}`);
      if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
      return mergedTreeOf(repo, headTip, baseTip) === null ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'author':
    case 'user':
      return userValue(store);
    case 'url':
      return `https://forge.local/${store.viewerLogin ?? ''}/${repo.name}/${issue.isPull ? 'pull' : 'issues'}/${issue.number}`;
    case 'createdAt':
    case 'updatedAt':
      return new Date(issue.createdAtSec * 1000).toISOString();
    case 'repository':
      return repoValue(repo);
    case 'labels': {
      const items = issue.labels.map((name) => typed('Label', { name }));
      const value = connectionValue('LabelConnection', { items, totalCount: items.length });
      value.pageArgs = args;
      return value;
    }
    case 'comments': {
      const items = issue.comments.map((comment) => typed('IssueComment', { repo, issue, comment }));
      const value = connectionValue('IssueCommentConnection', { items, totalCount: items.length });
      value.pageArgs = args;
      return value;
    }
    case 'files': {
      const files = pullFiles(repo, issue);
      const items = files.map((file) =>
        typed('PullRequestChangedFile', {
          path: file.filename as string,
          additions: file.additions as number,
          deletions: file.deletions as number,
          changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }),
      );
      const value = connectionValue('PullRequestFilesConnection', { items, totalCount: items.length });
      value.pageArgs = args;
      return value;
    }
    default:
      throw unknownField(issue.isPull ? 'PullRequest' : 'Issue', fieldName);
  }
}

function nodeById(ctx: Ctx, id: string): GqlValue | null {
  const raw = decodeId(id);
  const repoMatch = /^R_(\d+)$/.exec(raw);
  if (repoMatch !== null) {
    const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === Number(repoMatch[1]));
    return repo === undefined ? null : repoValue(repo);
  }
  const issueMatch = /^(I|PR)_(\d+)_(\d+)$/.exec(raw);
  if (issueMatch !== null) {
    const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === Number(issueMatch[2]));
    if (repo === undefined) return null;
    const issue = repo.issues.get(Number(issueMatch[3]));
    if (issue === undefined) return null;
    if (issueMatch[1] === 'PR' && !issue.isPull) return null;
    if (issueMatch[1] === 'I' && issue.isPull) return null;
    return issueValue(repo, issue);
  }
  if (raw === 'U_1') return userValue(ctx.store);
  return null;
}

function searchValue(ctx: Ctx, args: Record<string, unknown>): GqlValue {
  const query = String(args.query ?? '');
  const match = /repo:([^\s/]+)\/([^\s]+)/.exec(query);
  let items: GqlValue[] = [];
  if (match !== null) {
    const repo = ctx.store.repo(match[1] as string, match[2] as string);
    if (repo !== null) {
      items = [...repo.issues.values()]
        .filter((issue) => !issue.isPull)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueValue(repo, issue));
    }
  }
  const value = connectionValue('SearchResultItemConnection', { items, totalCount: items.length });
  value.issueCount = items.length;
  value.pageArgs = args;
  return value;
}

function resolveMutation(ctx: Ctx, fieldName: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  const repoFromId = (id: unknown): RepoRec => {
    const raw = decodeId(String(id ?? ''));
    const match = /^R_(\d+)$/.exec(raw);
    const repo = match === null ? undefined : [...store.repos.values()].find((candidate) => candidate.id === Number(match[1]));
    if (repo === undefined) throw new FieldProblem(`repository id ${String(id)} does not name a repository`);
    return repo;
  };
  const issueFromId = (id: unknown): { repo: RepoRec; issue: IssueRec } => {
    const raw = decodeId(String(id ?? ''));
    const match = /^(I|PR)_(\d+)_(\d+)$/.exec(raw);
    if (match === null) throw new FieldProblem(`id ${String(id)} does not name an issue or pull request`);
    const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(match[2]));
    const issue = repo?.issues.get(Number(match[3]));
    if (repo === undefined || issue === undefined) throw new FieldProblem(`id ${String(id)} does not name an issue or pull request`);
    return { repo, issue };
  };
  try {
    switch (fieldName) {
      case 'createIssue': {
        const repo = repoFromId(input.repositoryId);
        const issue = createIssueRecord(store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        return typed('CreateIssuePayload', { issue: issueValue(repo, issue), clientMutationId });
      }
      case 'closeIssue': {
        const { repo, issue } = issueFromId(input.issueId);
        issue.state = 'closed';
        return typed('CloseIssuePayload', { issue: issueValue(repo, issue), clientMutationId });
      }
      case 'createPullRequest': {
        const repo = repoFromId(input.repositoryId);
        const pull = createPullRecord(store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head: String(input.headRefName ?? ''),
          base: typeof input.baseRefName === 'string' ? input.baseRefName : undefined,
        });
        return typed('CreatePullRequestPayload', { pullRequest: issueValue(repo, pull), clientMutationId });
      }
      case 'mergePullRequest': {
        const { repo, issue } = issueFromId(input.pullRequestId);
        const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
        const outcome = mergePullRecord(store, repo, issue, methodRaw === 'MERGE' ? 'merge' : 'squash');
        if (!outcome.ok) throw new FieldProblem(outcome.reason === 'conflict' ? 'Pull Request is not mergeable' : 'Pull Request is already merged or closed');
        return typed('MergePullRequestPayload', { pullRequest: issueValue(repo, issue), clientMutationId });
      }
      case 'addComment': {
        const { repo, issue } = issueFromId(input.subjectId);
        const comment = { id: store.nextComment(), body: String(input.body ?? ''), createdSeq: store.nextSeq() };
        issue.comments.push(comment);
        const node = typed('IssueComment', { repo, issue, comment });
        const edge = typed('IssueCommentEdge', { node, cursor: cursorOf(issue.comments.length - 1) });
        return typed('AddCommentPayload', { commentEdge: edge, subject: issueValue(repo, issue), clientMutationId });
      }
      default:
        throw unknownField('Mutation', fieldName);
    }
  } catch (err) {
    if (err instanceof DomainError) throw new FieldProblem(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------- completion

function completeValue(ctx: Ctx, value: unknown, selectionSet: readonly SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, selectionSet));
  if (typeof value === 'object') {
    const record = value as GqlValue;
    if (typeof record.__type === 'string' && selectionSet !== null) {
      return execSelectionSet(ctx, record.__type, record, selectionSet);
    }
    return value;
  }
  return value;
}

function execSelectionSet(ctx: Ctx, typeName: string, source: GqlValue, selections: readonly SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      try {
        const raw = selection.name === '__type' && typeName === 'Query'
          ? resolveField(ctx, 'Query', source, selection)
          : resolveField(ctx, typeName, source, selection);
        out[key] = completeValue(ctx, raw, selection.selectionSet);
      } catch (err) {
        if (err instanceof FieldProblem) {
          ctx.errors.push({ message: err.message });
          out[key] = null;
        } else {
          throw err;
        }
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, execSelectionSet(ctx, selection.typeCondition ?? typeName, source, selection.selectionSet));
      }
      continue;
    }
    const fragment = ctx.fragments.get(selection.name);
    if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
      Object.assign(out, execSelectionSet(ctx, fragment.typeCondition, source, fragment.selectionSet));
    }
  }
  return out;
}

// ---------------------------------------------------------------- entry point

export function handleGraphQL(store: Store, body: unknown): RestResult {
  if (Array.isArray(body)) {
    const results = body.map((operation) => executeOperation(store, operation));
    return { status: 200, body: results };
  }
  const result = executeOperation(store, body);
  return { status: 200, body: result };
}

function executeOperation(store: Store, body: unknown): Record<string, unknown> {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  let variables: Variables = {};
  if (typeof record.variables === 'object' && record.variables !== null) variables = record.variables as Variables;
  else if (typeof record.variables === 'string') {
    try {
      variables = JSON.parse(record.variables) as Variables;
    } catch {
      variables = {};
    }
  }
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const operation = document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { store, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root = typed(rootType, {});
  const data = execSelectionSet(ctx, rootType, root, operation.selectionSet);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
