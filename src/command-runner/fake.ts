/**
 * The recording fake (command-runner ADR decision 4): the second adapter of the CommandRunner seam.
 *
 * It applies the same permission rule as the real runner, records every spec it is asked to start
 * (`starts`) and every spec it refused (`denials`), and answers from scripted results. Tests inject
 * it wherever a module takes a CommandRunner, and the "hostile repo runs nothing" proof asserts on
 * `starts`. It imports no test-kit and no test runner, so it is production-pure and exported from the index.
 */
import { decide as defaultDecide } from './decide.ts';
import { deniedResult, emptyResult } from './spec.ts';
import type {
  CommandResult,
  CommandRunner,
  CommandSpec,
  CommandStream,
  DecideFn,
  RunContext,
  StdinChunk,
  UserPermissions,
} from './spec.ts';

/** What a scripted run returns. Text is encoded as UTF-8; `ok` is derived from the exit code unless given. */
export interface ScriptedResult {
  readonly ok?: boolean;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stdout?: string | Uint8Array;
  readonly stderr?: string | Uint8Array;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
}

/** Stdin as recorded: the value for a string or bytes, the total byte length for an iterable. */
export type RecordedStdin = string | Uint8Array | { readonly iterableBytes: number };

/** A spec as recorded: identical to what was run, except that `stdin` is recorded as {@link RecordedStdin}. */
export type RecordedSpec = Omit<CommandSpec, 'stdin'> & { readonly stdin?: RecordedStdin };

export interface RecordingRunnerOptions {
  /** The permission rule. Defaults to the real `decide` with `user`. */
  readonly decide?: DecideFn;
  readonly user?: UserPermissions;
  /** Results consumed in order by allowed runs that `respond` does not answer; then a default success. */
  readonly script?: readonly ScriptedResult[];
  /** Answers a run from its spec; takes precedence over `script` when it returns a value. */
  readonly respond?: (spec: CommandSpec, ctx: RunContext) => ScriptedResult | undefined;
  /** Forward allowed specs to this runner (still recording them) instead of answering from the script. */
  readonly delegate?: CommandRunner;
}

export interface RecordingRunner extends CommandRunner {
  readonly starts: readonly RecordedSpec[];
  readonly denials: readonly RecordedSpec[];
  reset(): void;
}

const encoder = new TextEncoder();
const bytes = (v: string | Uint8Array | undefined): Uint8Array =>
  v === undefined ? new Uint8Array(0) : typeof v === 'string' ? encoder.encode(v) : v;

function toResult(r: ScriptedResult): CommandResult {
  const exitCode = r.exitCode === undefined ? 0 : r.exitCode;
  const timedOut = r.timedOut ?? false;
  const truncated = r.truncated ?? false;
  return emptyResult({
    ok: r.ok ?? (exitCode === 0 && !timedOut && !truncated),
    exitCode,
    signal: r.signal ?? null,
    stdout: bytes(r.stdout),
    stderr: bytes(r.stderr),
    truncated,
    timedOut,
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Reads a stdin iterable to the end so it can be recorded (and, with a delegate, forwarded as bytes). */
async function drain(source: AsyncIterable<StdinChunk>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of source) parts.push(bytes(chunk));
  return concat(parts);
}

export function createRecordingRunner(opts: RecordingRunnerOptions = {}): RecordingRunner {
  const rule: DecideFn = opts.decide ?? ((spec, ctx) => defaultDecide(spec, ctx, opts.user));
  const starts: RecordedSpec[] = [];
  const denials: RecordedSpec[] = [];
  let scriptIndex = 0;

  async function answer(spec: CommandSpec, ctx: RunContext): Promise<CommandResult> {
    const decision = rule(spec, ctx);
    let effective: CommandSpec = spec;
    let recordedStdin: RecordedStdin | undefined;
    const stdin = spec.stdin;
    if (stdin !== undefined && typeof stdin !== 'string' && !(stdin instanceof Uint8Array)) {
      const all = await drain(stdin);
      recordedStdin = { iterableBytes: all.length };
      effective = { ...spec, stdin: all };
    } else {
      recordedStdin = stdin;
    }
    const { stdin: _unused, ...rest } = spec;
    const recorded: RecordedSpec = recordedStdin === undefined ? rest : { ...rest, stdin: recordedStdin };

    if (!decision.allowed) {
      denials.push(recorded);
      return deniedResult(decision.diagnostic);
    }
    starts.push(recorded);
    if (opts.delegate !== undefined) return opts.delegate.run(effective, ctx);
    const responded = opts.respond?.(spec, ctx);
    if (responded !== undefined) return toResult(responded);
    const scripted = opts.script?.[scriptIndex];
    if (scripted !== undefined) {
      scriptIndex += 1;
      return toResult(scripted);
    }
    return toResult({});
  }

  return {
    get starts() {
      return starts;
    },
    get denials() {
      return denials;
    },
    reset() {
      starts.length = 0;
      denials.length = 0;
      scriptIndex = 0;
    },
    run: (spec, ctx) => answer(spec, ctx ?? {}),
    stream(spec, ctx): CommandStream {
      let killed = false;
      const done = answer(spec, ctx ?? {});
      return {
        // As with the real runner, a streamed run delivers its stdout through the iterable only.
        stdout: (async function* (): AsyncGenerator<Uint8Array> {
          const r = await done;
          if (!killed && r.stdout.length > 0) yield r.stdout;
        })(),
        result: done.then((r) => ({ ...r, stdout: new Uint8Array(0) })),
        kill: () => {
          killed = true;
        },
      };
    },
  };
}
