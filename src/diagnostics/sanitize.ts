/**
 * The one sanitiser every `gsd-atlas bug` bundle passes through (SKL-04, DIAGNOSTICS.md 9.3, threat T-03-321).
 *
 * A bundle is built as a TREE whose string leaves are all typed, and nothing else decides what leaves the machine:
 *   - `name`, `path` and `handle` are identifiers of the user's repository (a symbol, a file, a fact). `hashed` turns them
 *     into per-bundle tokens, `redacted` into `<removed>`, `raw` keeps them (and only after an explicit confirmation).
 *   - `text` is the user's own words. It is scrubbed in EVERY mode (paths, URLs, e-mail addresses, long hex strings and
 *     secret shapes become `[removed]`), because raw mode is about names and paths, never about secrets.
 *   - `code` is a fixed word the program itself chose (a tool, an outcome, a version, a bucket label). It is kept in every
 *     mode, but only when it LOOKS like one: a `code` leaf that holds anything else is treated as a name, so a builder's
 *     mistake costs a token and not a leak.
 *   - `count` is a number.
 * A bare string or number in the tree is an error, as is an invented leaf kind: the builder cannot forget to type a
 * field, because an untyped field makes the whole bundle fail instead of leaking. Object keys must have the fixed key
 * shape, so repository text can never become a key.
 *
 * Pure: no file, process or database.
 */
import type { Hasher } from './hash.ts';
import { scrubNote } from './scrub.ts';

/** The three ways a bundle treats the identifiers of the user's repository. */
export const MODES = ['hashed', 'redacted', 'raw'] as const;
export type Mode = (typeof MODES)[number];

/** The kinds of string leaf, and `count` for numbers. */
export const LEAF_KINDS = ['name', 'path', 'handle', 'text', 'code', 'count'] as const;
export type LeafKind = (typeof LEAF_KINDS)[number];

/** A typed leaf of a bundle tree. */
export interface Leaf {
  readonly leaf: LeafKind;
  readonly value: string | number;
}

/** The leaves a tree is built from. */
export const leaf = {
  name: (value: string): Leaf => ({ leaf: 'name', value }),
  path: (value: string): Leaf => ({ leaf: 'path', value }),
  handle: (value: string): Leaf => ({ leaf: 'handle', value }),
  text: (value: string): Leaf => ({ leaf: 'text', value }),
  code: (value: string): Leaf => ({ leaf: 'code', value }),
  count: (value: number): Leaf => ({ leaf: 'count', value }),
} as const;

/** A bundle before sanitising: typed leaves, booleans and null, in arrays and objects. */
export type Tree = Leaf | boolean | null | readonly Tree[] | { readonly [key: string]: Tree | undefined };

/** A bundle after sanitising: plain JSON. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** What a name, path or handle becomes in `redacted` mode. */
export const REMOVED_TOKEN = '<removed>';

/** What a fixed word may look like: letters, digits and the few marks versions, buckets and placeholders use. */
export const CODE_PATTERN = /^[A-Za-z0-9_.:@+<>–\- ]{1,64}$/u;

/** The shape of an object key. */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

export class SanitizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SanitizeError';
  }
}

const isLeaf = (value: unknown): value is Leaf =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'leaf' in value && 'value' in value;

function identifier(value: string, mode: Mode, hasher: Hasher): string {
  if (mode === 'raw') return value;
  return mode === 'redacted' ? REMOVED_TOKEN : hasher.token(value);
}

function leafOf(item: Leaf, mode: Mode, hasher: Hasher): Json {
  const kind: unknown = item.leaf;
  if (!(LEAF_KINDS as readonly unknown[]).includes(kind)) throw new SanitizeError(`unknown leaf kind ${JSON.stringify(String(kind)).slice(0, 40)}`);
  if (kind === 'count') {
    if (typeof item.value !== 'number') throw new SanitizeError('a count leaf holds a number');
    return Number.isFinite(item.value) ? item.value : null;
  }
  if (typeof item.value !== 'string') throw new SanitizeError(`a ${String(kind)} leaf holds a string`);
  switch (kind) {
    case 'text':
      return scrubNote(item.value);
    case 'code':
      return CODE_PATTERN.test(item.value) ? item.value : identifier(item.value, mode, hasher);
    default:
      return identifier(item.value, mode, hasher);
  }
}

/** The sanitised form of `tree` in `mode`. Throws a {@link SanitizeError} for an untyped or invented leaf and for a bad key. */
export function sanitize(tree: Tree, mode: Mode, hasher: Hasher): Json {
  if (tree === null || typeof tree === 'boolean') return tree;
  if (Array.isArray(tree)) return tree.map((item: Tree) => sanitize(item, mode, hasher));
  if (typeof tree === 'string' || typeof tree === 'number' || typeof tree === 'undefined') {
    throw new SanitizeError('an untyped value in a bundle: every string and number needs a leaf kind');
  }
  if (typeof tree !== 'object') throw new SanitizeError('an untyped value in a bundle');
  if (isLeaf(tree)) return leafOf(tree, mode, hasher);
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(tree)) {
    if (value === undefined) continue;
    if (!KEY_PATTERN.test(key)) throw new SanitizeError('a bundle key outside the fixed key shape');
    out[key] = sanitize(value, mode, hasher);
  }
  return out;
}
