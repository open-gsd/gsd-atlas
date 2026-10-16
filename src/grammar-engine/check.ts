import { createHash } from 'node:crypto';

import { GrammarLoadError } from './errors.ts';
import { GRAMMAR_LIMITS } from './limits.ts';
import { QUERY_KINDS } from './types.ts';
import type { GrammarInput } from './types.ts';

/** Lower-case hex sha256 of the bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Size caps on a grammar input (T-01-29): the wasm and each query. Shared by the real engine and
 * the fake so the contract suite means the same thing for both. The hash check is deliberately
 * not here: each engine states it where it loads, so the order "hash before instantiation" is
 * visible at the call site.
 */
export function assertInputSizes(input: GrammarInput): void {
  if (input.wasm.byteLength > GRAMMAR_LIMITS.wasmBytes) {
    throw new GrammarLoadError(
      'wasm_too_large',
      `${input.name}: grammar wasm is ${String(input.wasm.byteLength)} bytes, over the ${String(GRAMMAR_LIMITS.wasmBytes)} byte cap`,
    );
  }
  for (const kind of QUERY_KINDS) {
    const text = input.queries[kind];
    if (text === undefined) {
      continue;
    }
    const size = Buffer.byteLength(text, 'utf8');
    if (size > GRAMMAR_LIMITS.queryBytes) {
      throw new GrammarLoadError(
        'query_too_large',
        `${input.name}: ${kind} query is ${String(size)} bytes, over the ${String(GRAMMAR_LIMITS.queryBytes)} byte cap`,
      );
    }
  }
}

/** The message both engines use for a hash mismatch. */
export function hashMismatchMessage(input: GrammarInput, actual: string): string {
  return `${input.name}: grammar wasm sha256 is ${actual}, grammar.lock says ${input.expectedSha256}`;
}

/** UTF-8 byte length of a text. */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
