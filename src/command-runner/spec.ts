import type { Diagnostic } from '../facts/index.ts';

/** Default stdout cap: 16 MiB. */
export const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
/** Default stderr cap: 1 MiB. */
export const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;

/** Diagnostic codes the runner emits. */
export const COMMAND_CODES = {
  denied: 'command_denied',
  shimRejected: 'shim_rejected',
  spawnFailed: 'spawn_failed',
  outputCapExceeded: 'output_cap_exceeded',
  timeout: 'timeout',
} as const;

/** One chunk of batched stdin. */
export type StdinChunk = string | Uint8Array;

/** Everything the child may be fed on stdin: one string, one byte array, or an async stream of either. */
export type StdinSource = StdinChunk | AsyncIterable<StdinChunk>;

/**
 * What to run. An argument ARRAY plus an optional built-in id; it is never joined into a shell string,
 * never parsed by a shell, and never run through a `.cmd`/`.bat`/npm shim (D-11, FND-06).
 *
 * Providers build specs and never see policy: whether a spec may start is decided only inside the
 * runner (`decide`), from the spec, the run context and user-level permissions.
 */
export interface CommandSpec {
  /** A bare name (resolved on PATH) or an absolute path. */
  readonly executable: string;
  /** Arguments, one array element per argument. Passed to the child unchanged. */
  readonly args: readonly string[];
  /** Names the first-party built-in this spec claims to be (Phase 1: `git`). The runner verifies the claim. */
  readonly builtinId?: string;
  /** Overlaid on the inherited environment after the denylist is applied (see `scrubEnv`). */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Batched stdin: written in full (honouring backpressure), then closed. */
  readonly stdin?: StdinSource;
  /**
   * Kills the child with SIGKILL when exceeded. Absent means no wall-clock limit: plan 01-09 asks for a
   * 60 s default, which is held back until a human confirms that value (see the plan summary).
   */
  readonly timeoutMs?: number;
  /** Exceeding this kills the child and marks the result truncated. Default {@link DEFAULT_MAX_STDOUT_BYTES}. */
  readonly maxStdoutBytes?: number;
  /** Exceeding this truncates stderr without killing the child. Default {@link DEFAULT_MAX_STDERR_BYTES}. */
  readonly maxStderrBytes?: number;
}

/** Per-call context. Repo identity comes from the caller (the host), never from repo contents. */
export interface RunContext {
  /** Canonical absolute path of the repo this run is on behalf of; the key of `permissions.commands` entries. */
  readonly repo?: string;
  /** Parent environment to inherit for this call; defaults to the runner's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CommandResult {
  /** True only for a normal exit with code 0 that was neither denied, timed out, nor truncated by the stdout cap. */
  readonly ok: boolean;
  /** Null when the child was killed, never started, or was denied. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Captured stdout (empty for `stream()`, whose bytes are delivered through the iterable). */
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  /** True when stdout or stderr hit its cap. */
  readonly truncated: boolean;
  readonly timedOut: boolean;
  /** Present when the runner refused to start the spec. Nothing was started. */
  readonly denied?: Diagnostic;
  /** Present when the process could not be started or the executable could not be resolved. */
  readonly spawnError?: Diagnostic;
  /** Every diagnostic for this run (denial, spawn error, timeout, cap). */
  readonly diagnostics: readonly Diagnostic[];
}

export interface CommandStream {
  /** Stdout as it arrives. Ends when the child's stdout closes. */
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly result: Promise<CommandResult>;
  /** Kills the child (SIGKILL). Safe to call repeatedly or after exit. */
  kill(): void;
}

export interface CommandRunner {
  run(spec: CommandSpec, ctx?: RunContext): Promise<CommandResult>;
  stream(spec: CommandSpec, ctx?: RunContext): CommandStream;
}

/** The outcome of the permission rule. */
export type Decision =
  | { readonly allowed: true; readonly via: 'builtin'; readonly builtinId: string }
  | { readonly allowed: true; readonly via: 'user' }
  | { readonly allowed: false; readonly diagnostic: Diagnostic };

/** User-level permissions (`permissions.commands` in `~/.config/gsd-atlas/config.json`), injected by the caller. */
export interface UserPermissions {
  readonly allow: ReadonlyArray<{
    /** Canonical absolute repo path; compared exactly to `RunContext.repo`. */
    readonly repo: string;
    /** Compared exactly to `CommandSpec.executable`. */
    readonly executable: string;
    /** When present, the spec's arguments must start with exactly these. */
    readonly argsPrefix?: readonly string[];
  }>;
}

/** The permission rule as a function; the real runner and the recording fake both take one. */
export type DecideFn = (spec: CommandSpec, ctx: RunContext) => Decision;

const NO_BYTES: Uint8Array = new Uint8Array(0);

/** A result for a run that never produced output: everything empty, `ok` false unless overridden. */
export function emptyResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    stdout: NO_BYTES,
    stderr: NO_BYTES,
    truncated: false,
    timedOut: false,
    diagnostics: [],
    ...overrides,
  };
}

/** The result of a refused spec: nothing was started. */
export function deniedResult(denied: Diagnostic): CommandResult {
  return emptyResult({ denied, diagnostics: [denied] });
}

/** The result of a spec that could not be started (resolution failure or a spawn error). */
export function spawnErrorResult(spawnError: Diagnostic): CommandResult {
  return emptyResult({ spawnError, diagnostics: [spawnError] });
}
