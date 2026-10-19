/**
 * Per-type, versioned consent (docs/DIAGNOSTICS.md principles 2 and 3; docs/adr/15-user-controlled-diagnostics.md,
 * decisions 2 and 8). The choices live in one file in the USER's config folder, `diagnostics.json`, and nowhere else:
 * the loader's only inputs are that folder and the shipped catalog, so no repository file, environment variable or
 * agent request can enable a type.
 *
 * A type is approved only while the field list the user approved equals the catalog's current list for it: a release
 * that adds a field turns the type off until the user reviews it again, and a type the saved file does not mention is
 * denied. A file that is wrong in any way is ignored whole with one warning (half a consent is worse than none) and is
 * never overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Catalog, CatalogType } from './catalog.ts';
import { readBounded, sameRead, targetOf, writeFileAtomic } from './io.ts';
import type { BoundedRead, DiagnosticsFs } from './io.ts';

/** The file inside the user directory. */
export const CONSENT_FILE = 'diagnostics.json';

/** The largest consent file that is read or written, in bytes. A bigger file is ignored without being parsed. */
export const CONSENT_MAX_BYTES = 64 * 1024;

export const CONSENT_STATES = ['approved', 'denied', 'ask'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export interface ConsentEntry {
  readonly state: ConsentState;
  /** The field names the user approved (the catalog's list for the type at that time). Empty while denied. */
  readonly fields: readonly string[];
}

export interface Consent {
  readonly catalogVersion: number;
  readonly types: Readonly<Record<string, ConsentEntry>>;
}

const TYPE_ID = /^[a-z][a-z0-9_]{0,47}$/;

/** The strict schema of the file. An unknown key anywhere (`autoSubmit`, `enabled`, ...) refuses the whole file. */
export const ConsentFileSchema = z.strictObject({
  catalogVersion: z.int().positive(),
  types: z.record(
    z.string().regex(TYPE_ID),
    z.strictObject({
      state: z.enum(CONSENT_STATES),
      fields: z.array(z.string().regex(TYPE_ID)).max(64),
    }),
  ),
});

/** Every type of the catalog denied, with no fields approved. */
export function emptyConsent(catalog: Catalog): Consent {
  return {
    catalogVersion: catalog.catalogVersion,
    types: Object.fromEntries(catalog.types.map((type) => [type.id, { state: 'denied' as const, fields: [] }])),
  };
}

/** The saved field list is the catalog's list for `type`: same names, in any order. */
export function sameFields(saved: readonly string[], type: CatalogType): boolean {
  const wanted = type.fields.map((field) => field.name).sort();
  const have = [...saved].sort();
  return wanted.length === have.length && wanted.every((name, index) => name === have[index]);
}

/**
 * The type ids of `consent` that are approved (or "ask each time") against an OLDER field list than the catalog's
 * current one. They must be reviewed again before they count.
 */
export function reapprovalNeeded(consent: Consent, catalog: Catalog): string[] {
  const needed: string[] = [];
  for (const type of catalog.types) {
    const entry = consent.types[type.id];
    if (entry !== undefined && entry.state !== 'denied' && !sameFields(entry.fields, type)) needed.push(type.id);
  }
  return needed;
}

export interface LoadedConsent {
  /** The effective consent: every catalog type is present, and a type that needs review or is unknown is denied. */
  readonly consent: Consent;
  /** True when a valid consent file was read. */
  readonly saved: boolean;
  /** Types the user had approved whose field list changed: denied until they approve them again. */
  readonly needsReview: readonly string[];
  /** Types the catalog has and the saved file does not mention (denied), only when a file was read. */
  readonly newTypes: readonly string[];
  /** One sentence when the file was ignored; it never quotes the file. */
  readonly warning?: string;
}

const ignored = (why: string): string => `The diagnostics consent file was ignored: ${why}. Every data type is off.`;

/** What a rejected issue of each zod code means, as fixed words: a warning must not quote the file. */
const ISSUE_WORDS: Readonly<Record<string, string>> = {
  unrecognized_keys: 'unknown key',
  invalid_type: 'wrong type',
  invalid_format: 'malformed value',
  invalid_value: 'value not allowed',
  too_small: 'value too small',
  too_big: 'value too large',
  invalid_key: 'malformed type id',
};

function problemOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'the file is invalid';
  const where = issue.path.length === 0 ? 'the file' : issue.path.map(String).join('.');
  // A type id is file content too, so only the position of an offending entry is named, never a key.
  const named = issue.path.length > 1 ? 'a type entry' : where;
  return `${named}: ${ISSUE_WORDS[issue.code] ?? 'invalid value'}`;
}

type Inspected =
  | { readonly ok: true; readonly read: BoundedRead; readonly parsed: z.infer<typeof ConsentFileSchema> | null }
  | { readonly ok: false; readonly reason: string };

/** Read `file` through the bounded reader and check it against the strict schema. A missing file is valid and empty. */
function inspect(io: DiagnosticsFs, file: string): Inspected {
  const read = readBounded(io, file, CONSENT_MAX_BYTES);
  if (read.kind === 'refused') return { ok: false, reason: read.why };
  if (read.kind === 'missing') return { ok: true, read, parsed: null };
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: 'it is not valid JSON' };
  }
  const checked = ConsentFileSchema.safeParse(json);
  if (!checked.success) return { ok: false, reason: problemOf(checked.error) };
  return { ok: true, read, parsed: checked.data };
}

/**
 * The effective consent in `userDir`. Nothing is created: a fresh install reads one missing file and every type is
 * denied. The only input is `userDir` and the catalog.
 */
export function loadConsent(userDir: string, catalog: Catalog, io: DiagnosticsFs = fs): LoadedConsent {
  const base = emptyConsent(catalog);
  const found = inspect(io, path.join(userDir, CONSENT_FILE));
  if (!found.ok) return { consent: base, saved: false, needsReview: [], newTypes: [], warning: ignored(found.reason) };
  if (found.parsed === null) return { consent: base, saved: false, needsReview: [], newTypes: [] };

  const types: Record<string, ConsentEntry> = { ...base.types };
  const needsReview: string[] = [];
  const newTypes: string[] = [];
  for (const type of catalog.types) {
    const saved = found.parsed.types[type.id];
    if (saved === undefined) {
      newTypes.push(type.id);
      continue;
    }
    if (saved.state === 'denied') continue;
    if (!sameFields(saved.fields, type)) {
      needsReview.push(type.id);
      continue;
    }
    types[type.id] = { state: saved.state, fields: [...type.fields.map((field) => field.name)] };
  }
  return { consent: { catalogVersion: catalog.catalogVersion, types }, saved: true, needsReview, newTypes };
}

export type SaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'consent_invalid' | 'consent_too_large' | 'consent_changed' | 'write_failed'; readonly reason: string };

const TOO_LARGE = 'The diagnostics consent would be larger than 64 KiB, so nothing was written.';
const CHANGED = 'The diagnostics consent file changed while it was being written, so nothing was written. Run the command again.';
const NOT_WRITTEN = 'The diagnostics consent file could not be written and was not changed.';

/**
 * Write `consent` to `<userDir>/diagnostics.json`. The rules, each with a test:
 *   - the result is serialized, size-checked and validated BEFORE any write;
 *   - a file that is already there and fails validation is not touched (the user's mistake is not buried, and the loader
 *     ignores that file anyway: move it away, then enable again);
 *   - it is written to a temporary file in the same folder, mode 0600, flushed and renamed over the original, so a crash
 *     or a failure leaves the old file whole; the temporary file is removed on every failure;
 *   - if the file changed between the check and the rename, the other writer wins and nothing of ours replaces it;
 *   - a link to the file (a dotfile manager's) is followed, so the link stays a link.
 * Failure reasons are fixed sentences: they never quote the file, an error message or a path.
 */
export function saveConsent(userDir: string, consent: Consent, io: DiagnosticsFs = fs): SaveResult {
  const file = targetOf(path.join(userDir, CONSENT_FILE), io);
  const before = inspect(io, file);
  if (!before.ok) {
    return { ok: false, code: 'consent_invalid', reason: `The diagnostics consent file is invalid and was not changed: ${before.reason}. Move it away to start again.` };
  }
  const checked = ConsentFileSchema.safeParse(consent);
  if (!checked.success) return { ok: false, code: 'consent_invalid', reason: `The diagnostics consent is invalid and was not written: ${problemOf(checked.error)}.` };
  const text = `${JSON.stringify(checked.data, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > CONSENT_MAX_BYTES) return { ok: false, code: 'consent_too_large', reason: TOO_LARGE };

  const written = writeFileAtomic(io, file, text, () => sameRead(before.read, readBounded(io, file, CONSENT_MAX_BYTES)));
  if (written.ok) return { ok: true };
  return written.failure === 'changed'
    ? { ok: false, code: 'consent_changed', reason: CHANGED }
    : { ok: false, code: 'write_failed', reason: NOT_WRITTEN };
}
