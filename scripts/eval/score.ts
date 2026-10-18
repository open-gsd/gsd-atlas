import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { billableTokens, type SessionStatus, type Usage } from './claude-session.ts';
import { verifyCitation, type OracleContext } from './oracle.ts';
import type { AnswerItem, AnswerKey, Category, Granularity, Question } from './questions.ts';

/**
 * The scorer of the pre-registered eval (EVL-02, EVL-03, D-02).
 *
 * It marks the structured final answer of an agent session against an oracle answer key and
 * verifies every cited file:line on disk with the oracle's `verifyCitation`. It imports the oracle
 * and the question shapes only, never the system under test, and it is hashed into the
 * pre-registration, so any edit after the freeze is visible.
 *
 * Nothing here repairs an answer: text that is not the registered JSON shape is scored incorrect
 * with the reason `unparseable answer` (T-03-73).
 */

/**
 * `file+line` granularity matches an answered line to a key line when they are at most this many
 * lines apart: a block comment or a multi-line call reports its first or last line. Each key line
 * is matched at most once. Hashed with the file at the freeze.
 */
export const LINE_SLACK = 2;

/** At most this many cited items of one answer are verified; the rest are failures (T-03-74). */
export const MAX_CITATIONS = 200;

/** The longest `summary` the answer schema accepts, in characters (code points). */
export const MAX_SUMMARY_CHARS = 400;

const UNPARSEABLE = 'unparseable answer';

// ---------------------------------------------------------------------------------------------
// The answer shape (a zod twin of answer-schema.json; score.test.ts proves they agree)

const AnswerItemWireSchema = z.strictObject({
  file: z.string().min(1),
  line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  symbol: z.string().optional(),
});

export const AnswerSchema = z.strictObject({
  answer: z.enum(['found', 'not_found']),
  items: z.array(AnswerItemWireSchema),
  // JSON Schema counts code points, not UTF-16 units, so the twin does the same.
  summary: z.string().refine((value) => [...value].length <= MAX_SUMMARY_CHARS, {
    message: `summary must be at most ${MAX_SUMMARY_CHARS} characters`,
  }),
});
export type Answer = z.infer<typeof AnswerSchema>;

export type Extracted = { ok: true; answer: Answer } | { ok: false; reason: string; detail: string };

/**
 * Reads the agent's result text as the registered answer. `--json-schema` normally returns clean
 * JSON, so the text is parsed whole. The one tolerance, documented here because it is the only
 * one: when the whole text is not JSON, the substring from the first `{` to the last `}` is tried
 * once (a sentence or a code fence around the object). Anything else, and JSON that breaks the
 * schema, fails. Failures are scored, never repaired.
 */
export function extractAnswer(resultText: string): Extracted {
  const fail = (detail: string): Extracted => ({ ok: false, reason: UNPARSEABLE, detail });
  let value: unknown;
  try {
    value = JSON.parse(resultText);
  } catch {
    const first = resultText.indexOf('{');
    const last = resultText.lastIndexOf('}');
    if (first < 0 || last <= first) return fail('no JSON object in the text');
    try {
      value = JSON.parse(resultText.slice(first, last + 1));
    } catch {
      return fail('the text between the outermost braces is not JSON');
    }
  }
  const parsed = AnswerSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(issue === undefined ? 'schema violation' : `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  return { ok: true, answer: parsed.data };
}

// ---------------------------------------------------------------------------------------------
// Paths (T-03-71): an answered path is normalised or rejected, never trusted

export type NormalisedPath = { ok: true; path: string } | { ok: false; reason: string };

/** An absolute path as a forward-slash string with no trailing slash, for prefix comparison. */
function rootForm(dir: string): string {
  const slashed = dir.replace(/\\/g, '/');
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

/** The repository root spelled as given and as `realpath` resolves it. */
export function checkoutRoots(repoDir: string): string[] {
  const roots = new Set<string>([rootForm(path.resolve(repoDir))]);
  try {
    roots.add(rootForm(fs.realpathSync.native(repoDir)));
  } catch {
    // a missing checkout is reported by verifyCitation as `file missing`
  }
  return [...roots];
}

/** The checkout directory with symbolic links resolved, or undefined when it does not exist. */
function realCheckout(repoDir: string): string | undefined {
  try {
    return fs.realpathSync.native(repoDir);
  } catch {
    return undefined;
  }
}

/**
 * True when the cited file, with every symbolic link on its way resolved, lies outside the
 * checkout (T-03-71). `verifyCitation` checks the spelling of the path, not the target of a link,
 * so a link planted in the tree would be read through without this. A path that does not exist
 * returns false: `verifyCitation` reports it as `file missing`.
 */
function leavesCheckout(repoReal: string | undefined, rel: string): boolean {
  if (repoReal === undefined) return false;
  let real: string;
  try {
    real = fs.realpathSync.native(path.resolve(repoReal, rel));
  } catch {
    return false;
  }
  const back = path.relative(repoReal, real);
  return back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back);
}

function stripRoot(slashed: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const caseFold = /^[A-Za-z]:/.test(root);
    const head = slashed.slice(0, root.length);
    const same = caseFold ? head.toLowerCase() === root.toLowerCase() : head === root;
    if (same && slashed.charAt(root.length) === '/') return slashed.slice(root.length + 1);
  }
  return undefined;
}

/**
 * Backslashes become slashes and a leading `./` goes. An absolute path (a leading slash or a drive
 * letter) is converted to a relative one when it lies inside the checkout and rejected otherwise.
 * A `..` segment, an empty result and a NUL byte are rejected.
 */
export function normalisePath(raw: string, roots: readonly string[]): NormalisedPath {
  if (raw.includes('\0')) return { ok: false, reason: 'path contains a NUL byte' };
  let slashed = raw.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    const inside = stripRoot(slashed, roots);
    if (inside === undefined) return { ok: false, reason: 'path is absolute and outside the checkout' };
    slashed = inside;
  }
  const segments = slashed.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) return { ok: false, reason: 'path has a .. segment' };
  if (segments.length === 0) return { ok: false, reason: 'path is empty' };
  return { ok: true, path: segments.join('/') };
}

// ---------------------------------------------------------------------------------------------
// Projection and matching

export interface ScoredItem {
  file: string;
  line?: number;
  symbol?: string;
}

/** A symbol as compared: trimmed, without a leading `async ` and without a trailing `()`. */
export function normaliseSymbol(symbol: string | undefined): string | undefined {
  if (symbol === undefined) return undefined;
  const cleaned = symbol
    .trim()
    .replace(/^async\s+/, '')
    .replace(/\(\s*\)$/, '')
    .trim();
  return cleaned === '' ? undefined : cleaned;
}

/**
 * Items reduced to what the key's granularity compares: `file` keeps one entry per file,
 * `file+symbol` one per file and symbol, `file+line` keeps every item.
 */
export function projectItems(items: readonly ScoredItem[], granularity: Granularity): ScoredItem[] {
  const out: ScoredItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const symbol = normaliseSymbol(item.symbol);
    if (granularity === 'file') {
      if (seen.has(item.file)) continue;
      seen.add(item.file);
      out.push({ file: item.file });
    } else if (granularity === 'file+symbol') {
      const id = `${item.file}\0${symbol ?? ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(symbol === undefined ? { file: item.file } : { file: item.file, symbol });
    } else {
      out.push(item.line === undefined ? { file: item.file } : { file: item.file, line: item.line });
    }
  }
  return out;
}

/** Cost of matching a key item to an answered item, or undefined when they do not match. */
function matchCost(key: ScoredItem, given: ScoredItem, granularity: Granularity): number | undefined {
  if (key.file !== given.file) return undefined;
  if (granularity === 'file') return 0;
  if (granularity === 'file+symbol') {
    if (key.symbol === undefined) return 0;
    if (given.symbol === undefined) return undefined;
    return matchSymbols(key.symbol, given.symbol);
  }
  if (key.line === undefined || given.line === undefined) return undefined;
  return matchLines(key.line, given.line);
}

/** The distance between a key line and an answered line when they are within `LINE_SLACK`, else undefined. */
export function matchLines(keyLine: number, givenLine: number): number | undefined {
  const distance = Math.abs(keyLine - givenLine);
  return distance <= LINE_SLACK ? distance : undefined;
}

/**
 * Cost of matching two normalised symbols. The same string costs 0. A method written with its
 * class (`Circle.area`, `Circle#area`, `Circle::area`) matches a key symbol that names only the
 * method, and the other way round, on the last segment (cost 1); two qualified names must be equal
 * as a whole, so `Square.area` never matches `Circle.area`.
 */
export function matchSymbols(keySymbol: string, givenSymbol: string): number | undefined {
  if (keySymbol === givenSymbol) return 0;
  const keyParts = keySymbol.split(/::|[.#]/);
  const givenParts = givenSymbol.split(/::|[.#]/);
  if (keyParts.length > 1 && givenParts.length > 1) return undefined;
  return keyParts[keyParts.length - 1] === givenParts[givenParts.length - 1] ? 1 : undefined;
}

export interface SetMatch {
  matched: ScoredItem[];
  missing: ScoredItem[];
  extra: ScoredItem[];
}

/**
 * One-to-one matching of projected key items against projected answered items: candidate pairs are
 * taken cheapest first, ties in key order then answer order, so the result is deterministic.
 */
export function matchSets(key: readonly ScoredItem[], given: readonly ScoredItem[], granularity: Granularity): SetMatch {
  const pairs: Array<{ cost: number; k: number; g: number }> = [];
  key.forEach((keyItem, k) => {
    given.forEach((givenItem, g) => {
      const cost = matchCost(keyItem, givenItem, granularity);
      if (cost !== undefined) pairs.push({ cost, k, g });
    });
  });
  pairs.sort((a, b) => a.cost - b.cost || a.k - b.k || a.g - b.g);
  const keyUsed = new Set<number>();
  const givenUsed = new Set<number>();
  for (const pair of pairs) {
    if (keyUsed.has(pair.k) || givenUsed.has(pair.g)) continue;
    keyUsed.add(pair.k);
    givenUsed.add(pair.g);
  }
  return {
    matched: key.filter((_item, index) => keyUsed.has(index)),
    missing: key.filter((_item, index) => !keyUsed.has(index)),
    extra: given.filter((_item, index) => !givenUsed.has(index)),
  };
}

// ---------------------------------------------------------------------------------------------
// Scoring

export interface CitationFailure {
  file: string;
  line: number;
  reason: string;
}

export interface CitationScore {
  /** False for an abstain question: there is nothing to cite. */
  applicable: boolean;
  /** Answered items that carry a line. */
  total: number;
  verified: number;
  /** At least one cited file:line and every cited file:line verifies. */
  hasVerifiable: boolean;
  failures: CitationFailure[];
}

export interface Scored {
  correct: boolean;
  reason: string;
  answered: 'found' | 'not_found' | 'none';
  matched: ScoredItem[];
  missing: ScoredItem[];
  extra: ScoredItem[];
  citation: CitationScore;
}

function citationOf(applicable: boolean, total: number, failures: CitationFailure[]): CitationScore {
  const verified = total - failures.length;
  return { applicable, total, verified, hasVerifiable: applicable && total > 0 && verified === total, failures };
}

/** The key's items that an answer can name: an unresolved ADR citation has no file and is left out. */
function keyItemsOf(key: AnswerKey): ScoredItem[] {
  const items: ScoredItem[] = [];
  for (const item of key.items as readonly AnswerItem[]) {
    if (item.file === undefined) continue;
    items.push({
      file: item.file,
      ...(item.line === undefined ? {} : { line: item.line }),
      ...(item.symbol === undefined ? {} : { symbol: item.symbol }),
    });
  }
  return items;
}

/**
 * Marks one agent answer against the answer key of its question. `answerText` is the `result`
 * text of the session. Citations are verified against `ctx.repoDir`, the pinned prepared checkout.
 */
export async function scoreAnswer(
  question: Question,
  key: AnswerKey,
  answerText: string,
  ctx: OracleContext,
): Promise<Scored> {
  if (key.questionId !== question.id) {
    throw new RangeError(`answer key ${key.questionId} does not belong to question ${question.id}`);
  }
  const applicable = !key.abstain;
  const extracted = extractAnswer(answerText);
  if (!extracted.ok) {
    return {
      correct: false,
      reason: UNPARSEABLE,
      answered: 'none',
      matched: [],
      missing: [],
      extra: [],
      citation: citationOf(applicable, 0, []),
    };
  }
  const { answer } = extracted;
  const given = (): ScoredItem[] =>
    answer.items.map((item) => ({
      file: item.file,
      ...(item.line === undefined ? {} : { line: item.line }),
      ...(item.symbol === undefined ? {} : { symbol: item.symbol }),
    }));

  // An abstain question has nothing to find: the only correct answer is `not_found` with no items.
  if (key.abstain) {
    let reason = 'fabricated answer';
    if (answer.answer === 'not_found') reason = answer.items.length === 0 ? 'abstain correct' : 'abstain with items';
    return {
      correct: reason === 'abstain correct',
      reason,
      answered: answer.answer,
      matched: [],
      missing: [],
      extra: given(),
      citation: citationOf(false, 0, []),
    };
  }
  if (answer.answer === 'not_found') {
    return {
      correct: false,
      reason: 'gave up',
      answered: 'not_found',
      matched: [],
      missing: projectItems(keyItemsOf(key), key.granularity),
      extra: [],
      citation: citationOf(true, 0, []),
    };
  }

  const roots = checkoutRoots(ctx.repoDir);
  const repoReal = realCheckout(ctx.repoDir);
  const failures: CitationFailure[] = [];
  const valid: ScoredItem[] = [];
  const invalid: ScoredItem[] = [];
  let cited = 0;
  for (const item of answer.items) {
    const normalised = normalisePath(item.file, roots);
    if (item.line !== undefined) cited += 1;
    if (!normalised.ok) {
      invalid.push({ file: item.file, ...(item.line === undefined ? {} : { line: item.line }) });
      if (item.line !== undefined) failures.push({ file: item.file, line: item.line, reason: 'path rejected' });
      continue;
    }
    valid.push({
      file: normalised.path,
      ...(item.line === undefined ? {} : { line: item.line }),
      ...(item.symbol === undefined ? {} : { symbol: item.symbol }),
    });
    if (item.line === undefined) continue;
    const citation = { file: normalised.path, line: item.line };
    if (cited > MAX_CITATIONS) {
      failures.push({ ...citation, reason: 'too many citations' });
    } else if (leavesCheckout(repoReal, normalised.path)) {
      failures.push({ ...citation, reason: 'outside checkout' });
    } else {
      const result = await verifyCitation(ctx, citation, key.needles);
      if (!result.ok) failures.push({ ...citation, reason: result.reason ?? 'unverified' });
    }
  }

  const match = matchSets(
    projectItems(keyItemsOf(key), key.granularity),
    projectItems(valid, key.granularity),
    key.granularity,
  );
  const extra = [...match.extra, ...invalid];
  let reason: string;
  let correct: boolean;
  if (invalid.length > 0) {
    correct = false;
    reason = 'invalid path';
  } else if (match.missing.length > 0 && match.extra.length > 0 && key.equality === 'exact-set') {
    correct = false;
    reason = 'missing and extra items';
  } else if (match.missing.length > 0) {
    correct = false;
    reason = 'missing items';
  } else if (match.extra.length > 0 && key.equality === 'exact-set') {
    correct = false;
    reason = 'extra items';
  } else {
    correct = true;
    reason = 'correct';
  }
  return {
    correct,
    reason,
    answered: answer.answer,
    matched: match.matched,
    missing: match.missing,
    extra,
    citation: citationOf(applicable, cited, failures),
  };
}

// ---------------------------------------------------------------------------------------------
// The result row

/** What the harness knows about a session; `toResultRow` adds what the scorer knows. */
export interface RowPartial {
  questionId: string;
  category: Category;
  arm: 'atlas' | 'grep';
  /** 1-based repeat number of this question in this arm. */
  run: number;
  status: SessionStatus;
  usage: Usage;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  atlasToolCalls: number;
  wallMs: number;
  costUsd: number | null;
}

/**
 * The fields of a result row, as plan 03-05's `ResultRowSchema` lists them. Declared here (not
 * imported) because the scorer must not depend on the analysis modules; score.test.ts validates a
 * row against that schema when it is present.
 */
export interface ResultRowFields extends RowPartial {
  answered: Scored['answered'];
  correct: boolean;
  citation: { applicable: boolean; total: number; verified: number; hasVerifiable: boolean };
  /** Input + output + cache creation + cache read (D-06), computed by claude-session.ts. */
  billableTokens: number;
}

export function toResultRow(partial: RowPartial, scored: Scored): ResultRowFields {
  const { applicable, total, verified, hasVerifiable } = scored.citation;
  return {
    ...partial,
    answered: scored.answered,
    correct: scored.correct,
    citation: { applicable, total, verified, hasVerifiable },
    billableTokens: billableTokens(partial.usage),
  };
}
