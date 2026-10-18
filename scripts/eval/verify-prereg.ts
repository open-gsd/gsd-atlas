// RED stubs: the verifier and its command are not written yet.
export interface VerifyResult {
  readonly ok: boolean;
  readonly problems: string[];
  readonly notes: string[];
}

export interface VerifyOptions {
  readonly draft?: boolean;
}

export interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export function verifyPrereg(_path: string, _root: string, _options: VerifyOptions = {}): VerifyResult {
  return { ok: false, problems: ['verifyPrereg is implemented in Task 3'], notes: [] };
}

export function runCli(_argv: string[], _io: Io, _root: string): number {
  return 99;
}
