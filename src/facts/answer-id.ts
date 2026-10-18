import { randomBytes } from 'node:crypto';

/**
 * An answer id is `a_` followed by sixteen lower-case hex characters (eight random bytes). It names one
 * answer so a user can rate or report it later; ratings and the recorder store the id, never the answer
 * (D-16). It is random and holds no content, so it cannot be reversed to repository facts.
 */
export const ANSWER_ID_PATTERN = /^a_[0-9a-f]{16}$/;

const ID_BYTES = 8;

/** A source of random bytes. Defaults to the system source; injectable so tests can pin the output. */
export type RandomBytes = (size: number) => Uint8Array;

/**
 * Make a fresh answer id. Deliberately takes no request, tool name, path or answer: nothing about an
 * answer can leak into its id because nothing about an answer is passed in.
 */
export function createAnswerId(random: RandomBytes = randomBytes): string {
  const bytes = random(ID_BYTES);
  if (bytes.length !== ID_BYTES) {
    throw new Error(`answer id needs ${ID_BYTES} random bytes, got ${bytes.length}`);
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `a_${hex}`;
}

/** True only for a string of exactly the shape `createAnswerId` produces. */
export function isAnswerId(value: unknown): value is string {
  return typeof value === 'string' && ANSWER_ID_PATTERN.test(value);
}

/**
 * A session id is `s_` followed by sixteen lower-case hex characters. It names one run of answers (the flight
 * recorder writes a marker with it) so a user can rate a session; like an answer id it is random and holds no content.
 */
export const SESSION_ID_PATTERN = /^s_[0-9a-f]{16}$/;

/** Make a fresh session id (plan 03-17). */
export function createSessionId(random: RandomBytes = randomBytes): string {
  return `s_${createAnswerId(random).slice(2)}`;
}

/** True only for a string of exactly the shape `createSessionId` produces. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}
