/**
 * Query: `ask(request)` returns the full envelope (QRY-01). It validates the request, resolves the worktree,
 * and routes to a tool. Every outcome, including every error, is an envelope.
 */
import type { z } from 'zod';
import { PROTOCOL_VERSION, diagnostic } from '../facts/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import { decodeCursor, queryHash } from './cursor.ts';
import type { CursorPayload, CursorProblem, QueryParts } from './cursor.ts';
import { resolveQueryConfig } from './defaults.ts';
import { errorEnvelope } from './envelope.ts';
import { newNonce, normalizeText } from './fence.ts';
import { runFind } from './find.ts';
import type { FindContext, FreshOutcome } from './find.ts';
import { runRefs } from './refs.ts';
import { codeFindSchema, codeRefsSchema } from './tools.ts';
import type { ToolName } from './tools.ts';
import type { Query, QueryConfig, QueryDeps } from './types.ts';

/** The cap on any message that quotes something the caller supplied. */
const MESSAGE_MAX_CHARS = 200;

/** Fixed, short messages for a refused cursor: nothing from the cursor is echoed back. */
const BAD_CURSOR: Readonly<Record<CursorProblem, string>> = {
  malformed: 'The "more" cursor is malformed. Pass the value from a previous answer unchanged.',
  oversized: 'The "more" cursor is longer than allowed. Pass the value from a previous answer unchanged.',
  other_query: 'The "more" cursor was issued for a different query. Pass it only with the query that produced it.',
};

const say = (text: string): string => normalizeText(text, MESSAGE_MAX_CHARS);

function argsObject(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/** The request's arguments with its request-level `budget_tokens` and `fresh` folded in, for one schema check. */
function mergedInput(request: Request): Record<string, unknown> {
  return {
    ...argsObject(request.args),
    ...(request.budget_tokens === undefined ? {} : { budget_tokens: request.budget_tokens }),
    ...(request.fresh === undefined ? {} : { fresh: request.fresh }),
  };
}

const NO_FRESH: FreshOutcome = { degraded: [], diagnostics: [], stalePaths: [] };
const FRESH_UNFINISHED: FreshOutcome = { degraded: ['fresh_timeout'], diagnostics: [], stalePaths: [] };

/**
 * Read your own writes (A26, mcp-contract decision 7): ask the Indexer to bring the named paths up to date
 * before anything is read. A request that names no paths costs nothing. Every way this can go wrong degrades
 * the answer with `fresh_timeout` and still answers from the store: a port that did not finish, a port that
 * throws, and no port at all. Refused paths are reported as one warning; they are not a timeout.
 */
async function freshOutcome(
  deps: QueryDeps,
  config: QueryConfig,
  worktree: string,
  paths: readonly string[] | undefined,
): Promise<FreshOutcome> {
  if (paths === undefined || paths.length === 0) return NO_FRESH;
  if (deps.fresh === undefined) return FRESH_UNFINISHED;
  try {
    const report = await deps.fresh.ensureFresh(worktree, paths, config.ensureFreshWaitMs);
    const refused = report.invalid[0];
    return {
      degraded: report.complete ? [] : ['fresh_timeout'],
      diagnostics:
        refused === undefined
          ? []
          : [
              diagnostic(
                'invalid_fresh_path',
                'warning',
                'Some fresh paths were refused. Name repo-relative paths that stay inside the worktree.',
                say(refused),
              ),
            ],
      stalePaths: report.stalePaths,
    };
  } catch {
    return FRESH_UNFINISHED;
  }
}

/** The arguments every code tool takes that Query itself uses. */
interface CommonInput {
  readonly repo?: string | undefined;
  readonly more?: string | undefined;
  readonly fresh?: readonly string[] | undefined;
}

/** A request ready to run (its context and checked input), or the error envelope that ends it. */
type Prepared<I> = { readonly ctx: FindContext; readonly input: I } | { readonly error: Envelope };

/**
 * Everything the code tools share before they run: check the arguments against the tool's strict schema, find
 * the worktree, bind the cursor to this query, and read your own writes. The hash binds a cursor to the tool and
 * to the ranking-relevant arguments, so a cursor from another tool or another query is refused.
 */
async function prepare<I extends CommonInput>(
  deps: QueryDeps,
  config: QueryConfig,
  request: Request,
  tool: ToolName,
  schema: z.ZodType<I>,
  partsOf: (input: I, worktree: string) => QueryParts,
): Promise<Prepared<I>> {
  const parsed = schema.safeParse(mergedInput(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? 'arguments' : issue.path.join('.');
    return { error: errorEnvelope('invalid_args', say(`${where}: ${issue?.message ?? 'invalid'}`)) };
  }
  const input = parsed.data;

  const worktree = request.worktree ?? input.repo;
  if (worktree === undefined || worktree === '') {
    return { error: errorEnvelope('invalid_args', `${tool} needs a repository: pass repo or a worktree`) };
  }

  const hash = queryHash(tool, partsOf(input, worktree));
  let cursor: CursorPayload | null = null;
  if (input.more !== undefined) {
    const decoded = decodeCursor(input.more, hash, config.cursorMaxChars);
    if (!decoded.ok) return { error: errorEnvelope('bad_cursor', BAD_CURSOR[decoded.problem]) };
    cursor = decoded.payload;
  }

  const fresh = await freshOutcome(deps, config, worktree, input.fresh);
  return { ctx: { deps, config, worktree, fresh, nonce: (deps.nonce ?? newNonce)(), queryHash: hash, cursor }, input };
}

export function createQuery(deps: QueryDeps): Query {
  const config: QueryConfig = resolveQueryConfig(deps.config);

  return {
    async ask(request: Request): Promise<Envelope> {
      if (request.protocol !== PROTOCOL_VERSION) {
        return errorEnvelope(
          'unsupported_protocol',
          `protocol ${say(String(request.protocol))} is not supported; this host speaks protocol ${String(PROTOCOL_VERSION)}`,
        );
      }

      switch (request.kind) {
        case 'code_find': {
          const ready = await prepare(deps, config, request, 'code_find', codeFindSchema, (input, worktree) => ({
            worktree,
            name: input.name,
            kind: input.kind,
            mode: input.mode ?? 'auto',
            cwd: input.cwd,
          }));
          return 'error' in ready ? ready.error : runFind(ready.ctx, ready.input);
        }
        case 'code_refs': {
          const ready = await prepare(deps, config, request, 'code_refs', codeRefsSchema, (input, worktree) => ({
            worktree,
            name: input.name,
            kind: input.kind,
            mode: 'refs',
            path: input.path,
            cwd: input.cwd,
          }));
          return 'error' in ready ? ready.error : runRefs(ready.ctx, ready.input);
        }
        default:
          return errorEnvelope('unknown_kind', `request kind ${say(JSON.stringify(request.kind))} is not known to this host`);
      }
    },
  };
}
