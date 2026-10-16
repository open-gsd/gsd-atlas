/**
 * Golden files for `gsd-atlas lang test` (D-02, FND-11).
 *
 * A golden is the checked-in record of what a module's queries capture over one fixture:
 * spans and texts only. It carries no parse-quality number; that metric is measured by the CI
 * budget job, not here (D-02, D-06).
 */
import type { Capture } from '../grammar-engine/index.ts';

/** The position convention every golden states about itself (research A7). */
export const GOLDEN_CONVENTION = '0-based line, 0-based UTF-16 column, end exclusive';

export const GOLDEN_SUFFIX = '.golden.json';

export interface GoldenCapture {
  readonly query: string;
  readonly name: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly text: string;
}

export interface Golden {
  readonly schema: 1;
  readonly fixture: string;
  readonly convention: string;
  readonly hadBom: boolean;
  readonly captures: readonly GoldenCapture[];
}

/** The first place a golden and a run disagree. `index` is -1 for a header field. */
export interface GoldenDifference {
  readonly index: number;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export function goldenFileName(fixture: string): string {
  return `${fixture}${GOLDEN_SUFFIX}`;
}

function renderCapture(capture: Capture): GoldenCapture {
  return {
    query: capture.query,
    name: capture.name,
    startLine: capture.span.startLine,
    startColumn: capture.span.startColumn,
    endLine: capture.span.endLine,
    endColumn: capture.span.endColumn,
    text: capture.text,
  };
}

/** Render a run as a golden. Captures keep the order the engine produced (it sorts them). */
export function renderGolden(
  fixture: string,
  run: { readonly hadBom: boolean; readonly captures: readonly Capture[] },
): Golden {
  return {
    schema: 1,
    fixture,
    convention: GOLDEN_CONVENTION,
    hadBom: run.hadBom,
    captures: run.captures.map(renderCapture),
  };
}

/** Two-space indented JSON with a final LF, so a regenerated golden diffs cleanly in git. */
export function serializeGolden(golden: Golden): string {
  return `${JSON.stringify(golden, null, 2)}\n`;
}

const CAPTURE_FIELDS = ['query', 'name', 'startLine', 'startColumn', 'endLine', 'endColumn', 'text'] as const;
const HEADER_FIELDS = ['schema', 'fixture', 'convention', 'hadBom'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCapture(index: number, expected: unknown, actual: GoldenCapture): GoldenDifference | null {
  if (!isRecord(expected)) {
    return { index, field: 'capture', expected, actual };
  }
  const actualRecord: Record<string, unknown> = { ...actual };
  for (const field of CAPTURE_FIELDS) {
    if (expected[field] !== actualRecord[field]) {
      return { index, field, expected: expected[field], actual: actualRecord[field] };
    }
  }
  for (const field of Object.keys(expected)) {
    if (!(CAPTURE_FIELDS as readonly string[]).includes(field)) {
      return { index, field, expected: expected[field], actual: undefined };
    }
  }
  return null;
}

/**
 * Compare a parsed golden (`expected`, untrusted JSON) with the run rendered as `actual`.
 * Returns null when they are equal, otherwise the first difference: header fields first, then
 * the captures in order. Never throws.
 */
export function compareGolden(expected: unknown, actual: Golden): GoldenDifference | null {
  if (!isRecord(expected)) {
    return { index: -1, field: 'document', expected, actual: 'an object' };
  }
  const actualHeader: Record<string, unknown> = { ...actual };
  for (const field of HEADER_FIELDS) {
    if (expected[field] !== actualHeader[field]) {
      return { index: -1, field, expected: expected[field], actual: actualHeader[field] };
    }
  }
  const expectedCaptures = expected['captures'];
  if (!Array.isArray(expectedCaptures)) {
    return { index: -1, field: 'captures', expected: expectedCaptures, actual: 'an array' };
  }
  const count = Math.max(expectedCaptures.length, actual.captures.length);
  for (let index = 0; index < count; index += 1) {
    const want: unknown = expectedCaptures[index];
    const got = actual.captures[index];
    if (index >= expectedCaptures.length) {
      return { index, field: 'capture', expected: 'absent', actual: got };
    }
    if (got === undefined) {
      return { index, field: 'capture', expected: want, actual: 'absent' };
    }
    const difference = compareCapture(index, want, got);
    if (difference !== null) {
      return difference;
    }
  }
  return null;
}
