/**
 * node scripts/adr-citations-check.ts --dir <prepared checkout> [--sample 20] [--seed 7] [--numbers 1,2,3]
 *
 * Red scaffold (plan 03-24, Task 3): the exports exist so the tests fail on their assertions.
 */

/** One citation as a line in a file (1-based line). */
export interface LineHit {
  readonly file: string;
  readonly line: number;
}

/** One citation the store holds. */
export interface StoreHit extends LineHit {
  readonly number: number;
}

export interface Comparison {
  readonly agree: number;
  readonly storeOnly: readonly LineHit[];
  readonly oracleOnly: readonly LineHit[];
}

export interface NumberRow {
  readonly number: number;
  readonly oracle: number;
  readonly store: number;
  readonly agree: number;
  readonly storeOnly: number;
  readonly oracleOnly: number;
}

export interface CheckOptions {
  readonly dir: string;
  readonly sample?: number;
  readonly seed?: number;
  readonly numbers?: readonly number[];
  readonly tsconfig?: string;
  readonly out?: (line: string) => void;
  readonly readStoreCitations?: (dir: string, workDir: string) => Promise<readonly StoreHit[]>;
}

export interface CheckReport {
  readonly ok: boolean;
  readonly rows: readonly NumberRow[];
  readonly agree: number;
  readonly storeOnly: number;
  readonly oracleOnly: number;
}

export function compareLines(oracle: readonly LineHit[], store: readonly LineHit[], slack: number): Comparison {
  void oracle;
  void store;
  void slack;
  return { agree: 0, storeOnly: [], oracleOnly: [] };
}

export function sampleNumbers(census: readonly number[], count: number, seed: number): number[] {
  void census;
  void count;
  void seed;
  return [];
}

export function withinThreshold(storeOnly: number, oracleOnly: number, oracleTotal: number): boolean {
  void storeOnly;
  void oracleOnly;
  void oracleTotal;
  return false;
}

export function buildAndReadCitations(dir: string, workDir: string): Promise<StoreHit[]> {
  void dir;
  void workDir;
  return Promise.resolve([]);
}

export function runCheck(options: CheckOptions): Promise<CheckReport> {
  void options;
  return Promise.resolve({ ok: false, rows: [], agree: 0, storeOnly: 0, oracleOnly: 0 });
}

export function runCli(
  argv: string[],
  write: (text: string) => void,
  overrides: Partial<CheckOptions> = {},
): Promise<number> {
  void argv;
  void write;
  void overrides;
  return Promise.resolve(1);
}
