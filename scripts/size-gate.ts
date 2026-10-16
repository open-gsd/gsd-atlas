/**
 * node scripts/size-gate.ts [--files N] [--edits N] [--symbols N] [--max-ratio R] [--maintain-every N]
 *
 * The store size gate (STO-05). Unimplemented in this commit: the tests that drive it are written first.
 */

export interface SizeGateOptions {
  readonly files?: number;
  readonly symbolsPerFile?: number;
  readonly edits?: number;
  readonly maxRatio?: number;
  readonly maintainEvery?: number;
}

export interface SizeGateResult {
  readonly freshBytes: number;
  readonly editedBytes: number;
  readonly ratio: number;
  readonly ok: boolean;
}

export async function runSizeGate(_options: SizeGateOptions = {}): Promise<SizeGateResult> {
  throw new Error('runSizeGate is not implemented yet');
}

export async function runCli(_argv: string[], _write: (text: string) => void): Promise<number> {
  throw new Error('runCli is not implemented yet');
}
