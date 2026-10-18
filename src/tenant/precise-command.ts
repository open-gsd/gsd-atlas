/**
 * The approved `precise.command` gate (plan 03-29, SEC-02, OQ5; trust-boundaries ADR 3 and command-runner ADR 4).
 *
 * A language module may declare a command that indexes the project. A manifest only PROPOSES it: nothing here, and nothing a
 * repository holds, can make it run. `maintain resolve` runs it only when a person approved exactly that command for this
 * repository with `gsd-atlas allow` (the approval binds the executable, the arguments and the working directory by their
 * hash), and only through the CommandRunner, whose own rule checks the approval again. The helper reports how the process
 * ended and for how long, never what it printed: the output of a third-party command is untrusted, is not stored, is not
 * returned and has no importer in Phase 3 (SCIP is Phase 9).
 */
import { COMMAND_CODES } from '../command-runner/index.ts';
import type { CommandRunner } from '../command-runner/index.ts';
import { diagnostic } from '../facts/index.ts';
import type { DegradedCode, Diagnostic } from '../facts/index.ts';
import { readManifest, resolveModules } from '../lang/index.ts';
import type { Roots } from '../lang/index.ts';
import type { CommandGate, CommandReport } from './types.ts';

/** A command a module's manifest declares, with the module that proposes it. */
export interface DeclaredCommand {
  readonly module: string;
  readonly command: readonly string[];
}

/**
 * The `precise.command` of every active module of the repository, in module-name order. Read from manifests only, each time
 * it is asked: a manifest is data, so an edit after an approval simply no longer matches the approval's hash.
 */
export function declaredPreciseCommands(roots: Roots): readonly DeclaredCommand[] {
  const found: DeclaredCommand[] = [];
  for (const entry of resolveModules(roots).modules) {
    if (entry.extensions.every((extension) => entry.inactiveExtensions.includes(extension))) continue;
    const read = readManifest(entry.dir);
    const precise = read.ok ? read.manifest.precise : undefined;
    if (precise !== undefined && 'command' in precise) found.push({ module: entry.name, command: precise.command });
  }
  return found;
}

export interface PreciseCommandDeps {
  /** The Host's runner: the only thing that starts a process. */
  readonly runner: CommandRunner;
  /** The repository's root: the approval's repository, the working directory and the runner's context. */
  readonly repoDir: string;
  /** The manifest's argument array: the executable first. */
  readonly command: readonly string[];
  /** The approved time limit (`precise.requestTimeoutMs`), in milliseconds. */
  readonly timeoutMs: number;
  /** The clock of the duration, in milliseconds. */
  readonly now: () => number;
  /** Whether a person approved exactly this command for this repository and this Host may use the approval. */
  readonly approved: CommandGate['approved'];
  /** The Host's mapping of a refused start to the degraded answer, with its fixed diagnostic. */
  readonly needsApprovalFrom: CommandGate['needsApprovalFrom'];
}

/** What came of it: the status report, and, for a command that was not approved, the answer the caller adds to its envelope. */
export interface PreciseCommandOutcome {
  readonly report: CommandReport;
  readonly refusal?: { readonly degraded: Extract<DegradedCode, 'needs_approval'>; readonly diagnostic: Diagnostic };
}

const notRun = (needsApproval: boolean): CommandReport => ({
  ran: false,
  ok: false,
  exitCode: null,
  signal: null,
  timedOut: false,
  ms: 0,
  needsApproval,
});

export async function runApprovedPreciseCommand(deps: PreciseCommandDeps): Promise<PreciseCommandOutcome> {
  const [executable, ...args] = deps.command;
  if (executable === undefined) return { report: notRun(false) };

  // The check comes first so that a command nobody approved is not even offered to the runner (SEC-01: an unapproved command
  // is never attempted, only refused). The runner's own rule still decides when it is asked.
  if (!deps.approved(deps.command)) {
    const refusal = deps.needsApprovalFrom({ denied: diagnostic(COMMAND_CODES.denied, 'warning', 'the command is not approved') });
    return { report: notRun(true), ...(refusal === null ? {} : { refusal }) };
  }

  const startedAt = deps.now();
  const result = await deps.runner.run({ executable, args, cwd: deps.repoDir, timeoutMs: deps.timeoutMs }, { repo: deps.repoDir });
  const ms = Math.max(0, deps.now() - startedAt);

  // A refusal at the last moment (the approval changed, the origin may not use it) is a missing approval all the same.
  const refusal = deps.needsApprovalFrom(result);
  if (refusal !== null) return { report: notRun(true), refusal };
  // Not started for another reason (no such executable, a refused spec): neither run nor a question of approval.
  if (result.denied !== undefined || result.spawnError !== undefined) return { report: notRun(false) };
  return {
    report: {
      ran: true,
      ok: result.exitCode === 0 && result.signal === null && !result.timedOut,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      ms,
      needsApproval: false,
    },
  };
}

/**
 * One report for several commands (several modules may declare one): `ran` when any ran, `ok` when every one that ran ended well,
 * `needsApproval` when any was not approved, and the first failure's exit code and signal, else the first run's.
 */
export function mergeCommandReports(reports: readonly CommandReport[]): CommandReport | undefined {
  if (reports.length === 0) return undefined;
  const ran = reports.filter((each) => each.ran);
  const lead = ran.find((each) => !each.ok) ?? ran[0];
  return {
    ran: ran.length > 0,
    ok: ran.length > 0 && ran.every((each) => each.ok),
    exitCode: lead?.exitCode ?? null,
    signal: lead?.signal ?? null,
    timedOut: reports.some((each) => each.timedOut),
    ms: reports.reduce((sum, each) => sum + each.ms, 0),
    needsApproval: reports.some((each) => each.needsApproval),
  };
}
