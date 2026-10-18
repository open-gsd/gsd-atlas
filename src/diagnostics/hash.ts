/**
 * Name and path hashing for `gsd-atlas bug` (SKL-04, DIAGNOSTICS.md 9.3, research assumption A5): in the default `hashed`
 * mode a symbol name, a file path or a fact handle leaves the machine only as a token, so the sequence of calls and the
 * repeats in a flight-recorder excerpt stay visible without the names.
 *
 * The token is HMAC-SHA256 over the string with a random key of 16 bytes that exists for ONE bundle. The key lives in this
 * closure only: it is never stored, never returned and never written, so
 *   - inside one bundle the same string always gives the same token (a repeat is visible as a repeat);
 *   - two bundles give the same string two different tokens (they cannot be linked);
 *   - a dictionary of symbol names cannot be hashed to match the tokens, because nobody holds the key (a plain hash would
 *     fall to exactly that attack).
 * Eight hexadecimal digits are enough to tell the names of one bundle apart and too short to be worth attacking.
 */
import { createHmac, randomBytes } from 'node:crypto';

/** The size of the per-bundle key, in bytes. */
export const HASH_KEY_BYTES = 16;

/** What a hashed name or path looks like. */
export const HASH_TOKEN_PATTERN = /^<h:[0-9a-f]{8}>$/;

export interface Hasher {
  /** The token of `value`: `<h:` and eight lower-case hexadecimal digits and `>`. */
  token(value: string): string;
}

/** The source of the key's bytes; a test injects a fixed one. */
export type RandomSource = (size: number) => Uint8Array;

/** A hasher with a fresh random key. `random` is a TEST HOOK; production uses the operating system's source. */
export function createHasher(random: RandomSource = randomBytes): Hasher {
  const key = Buffer.from(random(HASH_KEY_BYTES));
  return {
    token(value: string): string {
      return `<h:${createHmac('sha256', key).update(value, 'utf8').digest('hex').slice(0, 8)}>`;
    },
  };
}
