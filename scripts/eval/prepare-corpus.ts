// RED stub (plan 03-07, task 3): the exported surface with no behaviour yet.

export type PrepareErrorCode =
  | 'manifest_invalid'
  | 'unknown_corpus'
  | 'corpus_not_pinned'
  | 'destination_inside_repo'
  | 'fetch_failed'
  | 'sha_mismatch'
  | 'install_failed'
  | 'npm_unavailable'
  | 'record_missing'
  | 'record_invalid'
  | 'clone_destination_not_empty';

export class PrepareError extends Error {
  readonly code: PrepareErrorCode;
  constructor(code: PrepareErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PrepareError';
    this.code = code;
  }
}

export interface PreparedRecord {
  corpusId: string;
  sha: string;
  npmCi: boolean;
  typescriptVersion: string | null;
  lockSha256: string | null;
  dir: string;
}

/** An executable and the arguments that come before the ones this module appends. */
export interface Command {
  command: string;
  args: string[];
}

export interface PrepareOptions {
  id: string;
  dest: string;
  npmCi: boolean;
  fetchCommand?: Command;
  npm?: Command;
  manifest?: unknown;
}

const NOTHING: PreparedRecord = { corpusId: '', sha: '', npmCi: false, typescriptVersion: null, lockSha256: null, dir: '' };

export function resolveNpm(): Command {
  return { command: 'npm', args: [] };
}

export function prepareCorpus(_options: PrepareOptions): PreparedRecord {
  return { ...NOTHING };
}

export function readPreparedRecord(_dir: string, _manifest?: unknown): PreparedRecord {
  return { ...NOTHING };
}

export function cloneCheckout(_from: string, _to: string): void {
  // not implemented
}

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

export interface CliDeps {
  fetchCommand?: Command;
  npm?: Command;
  manifest?: unknown;
}

export function runCli(_argv: readonly string[], _io: CliIo, _deps?: CliDeps): number {
  return 99;
}
