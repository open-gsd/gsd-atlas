/**
 * Generated file facts for the durability tests of plan 02-12: every file has the same shape, so a test can tell
 * a half-written file from a whole one by counting rows. Shared by the writer child process and the tests.
 */
import type { FileFacts, Span } from '../../src/facts/index.ts';

export const SYMBOLS_PER_FILE = 20;
export const REFS_PER_FILE = 20;
export const IMPORTS_PER_FILE = 3;

const span = (startLine: number, startColumn: number, endLine: number, endColumn: number): Span => ({
  startLine,
  startColumn,
  endLine,
  endColumn,
});

export const generatedPath = (index: number): string => `src/gen/f${index}.ts`;

/** A 40-hex blob id that is unique per index. */
export const generatedHash = (index: number): string => (index + 1).toString(16).padStart(40, '0');

/** File `index`: 20 symbols (`sym0` to `sym19`), 20 reference sites, 3 imports. */
export function generatedFacts(index: number): FileFacts {
  return {
    path: generatedPath(index),
    contentHash: generatedHash(index),
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: Array.from({ length: SYMBOLS_PER_FILE }, (_, j) => ({
      name: `sym${j}`,
      kind: 'function',
      span: span(j * 3, 0, j * 3 + 2, 1),
      exported: true,
    })),
    refSites: Array.from({ length: REFS_PER_FILE }, (_, j) => ({
      name: `sym${(j + 1) % SYMBOLS_PER_FILE}`,
      span: span(j * 3 + 1, 2, j * 3 + 1, 8),
      kind: 'call' as const,
      enclosing: j,
    })),
    imports: Array.from({ length: IMPORTS_PER_FILE }, (_, j) => ({
      path: `./dep${j}`,
      span: span(100 + j, 0, 100 + j, 20),
      style: 'es' as const,
    })),
    exports: [],
    parse: { errorBytes: 0, totalBytes: 2000 },
  };
}
