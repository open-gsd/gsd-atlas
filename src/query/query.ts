/**
 * Query: `ask(request)` returns the full envelope (QRY-01). It validates the request, resolves the worktree,
 * and routes to a tool. Every outcome, including every error, is an envelope.
 */
import { PROTOCOL_VERSION } from '../facts/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import { decodeCursor, queryHash } from './cursor.ts';
import type { CursorPayload, CursorProblem } from './cursor.ts';
import { resolveQueryConfig } from './defaults.ts';
import { errorEnvelope } from './envelope.ts';
import { newNonce, normalizeText } from './fence.ts';
import { runFind } from './find.ts';
import { codeFindSchema } from './tools.ts';
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
      if (request.kind !== 'code_find') {
        return errorEnvelope('unknown_kind', `request kind ${say(JSON.stringify(request.kind))} is not known to this host`);
      }

      const parsed = codeFindSchema.safeParse(mergedInput(request));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined || issue.path.length === 0 ? 'arguments' : issue.path.join('.');
        return errorEnvelope('invalid_args', say(`${where}: ${issue?.message ?? 'invalid'}`));
      }
      const input = parsed.data;

      const worktree = request.worktree ?? input.repo;
      if (worktree === undefined || worktree === '') {
        return errorEnvelope('invalid_args', 'code_find needs a repository: pass repo or a worktree');
      }

      const hash = queryHash('code_find', {
        worktree,
        name: input.name,
        kind: input.kind,
        mode: input.mode ?? 'auto',
        cwd: input.cwd,
      });
      let cursor: CursorPayload | null = null;
      if (input.more !== undefined) {
        const decoded = decodeCursor(input.more, hash, config.cursorMaxChars);
        if (!decoded.ok) return errorEnvelope('bad_cursor', BAD_CURSOR[decoded.problem]);
        cursor = decoded.payload;
      }

      return runFind({ deps, config, worktree, nonce: (deps.nonce ?? newNonce)(), queryHash: hash, cursor }, input);
    },
  };
}
