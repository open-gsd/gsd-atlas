/**
 * The report a user would send, rendered locally and deterministically (docs/DIAGNOSTICS.md section 5): a title, labels,
 * a short human summary and ONE fenced JSON block (`diagnostics-v1`) holding only fields of approved types plus the
 * catalog version. Nothing else is in the body, and nothing here submits it: the same bytes are what the user reads in
 * `gsd-atlas diagnostics preview`.
 */
import { valueFits } from './catalog.ts';
import type { Catalog, CatalogType } from './catalog.ts';
import { ABOUT, ratingSymbol } from './collect.ts';
import type { RatingFact } from './collect.ts';
import { sameFields } from './consent.ts';
import type { Consent } from './consent.ts';
import { scrubNote } from './scrub.ts';

export interface RenderInput {
  readonly catalog: Catalog;
  /** The EFFECTIVE consent (`loadConsent(...).consent`). */
  readonly consent: Consent;
  /** The collected values per type id; only approved types are read. */
  readonly values: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The version of this build; it is the report's `atlas_version`. */
  readonly version: string;
  /** Types the user set to "ask each time" and said yes to for THIS report. */
  readonly include?: readonly string[];
  /** The user's own note for this report: used only when the notes type is included, and scrubbed again here. */
  readonly note?: string;
  /** The rating the user gave for this report: used only when the ratings type is included. */
  readonly rating?: RatingFact;
}

export interface Report {
  readonly title: string;
  readonly labels: readonly string[];
  readonly body: string;
  /** The object inside the `diagnostics-v1` block. */
  readonly json: Readonly<Record<string, unknown>>;
}

const EMPTY: Report = { title: '', labels: [], body: '', json: {} };

/** The operating systems the title and the `os:` label may name; anything else is left out of both. */
const OS_FAMILIES: readonly string[] = ['macOS', 'Linux', 'Windows'];

/** The label each rating value has (`↔` is "side": it worked, but not impressively). */
const RATING_LABEL: Readonly<Record<RatingFact['value'], string>> = { up: 'rating:up', meh: 'rating:side', down: 'rating:down' };

/** At most this many rating entries are reported. */
const RATINGS_MAX = 20;

/** The types that go into this report, in catalog order: approved (or asked about, and said yes to) at the current field list. */
function included(input: RenderInput): CatalogType[] {
  const asked = new Set(input.include ?? []);
  return input.catalog.types.filter((type) => {
    const entry = input.consent.types[type.id];
    if (entry === undefined) return false;
    const takes = entry.state === 'approved' || (entry.state === 'ask' && asked.has(type.id));
    return takes && sameFields(entry.fields, type);
  });
}

/** The collected values of one type, with the user's note and rating for this report applied; the note is scrubbed here whatever its source. */
function valuesOf(input: RenderInput, typeId: string): Record<string, unknown> {
  const have: Record<string, unknown> = { ...(input.values[typeId] ?? {}) };
  if (typeId === 'notes') {
    const raw = input.note ?? have['note'];
    if (typeof raw === 'string') {
      const scrubbed = scrubNote(raw);
      have['note'] = scrubbed === '' ? null : scrubbed;
    }
  }
  if (typeId === 'ratings' && input.rating !== undefined && ABOUT.test(input.rating.about)) {
    const given = { about: input.rating.about, value: ratingSymbol(input.rating.value) };
    const list = Array.isArray(have['rating']) ? (have['rating'] as Array<{ about?: unknown; value?: unknown }>) : [];
    const merged = list.some((entry) => entry.about === given.about && entry.value === given.value) ? list : [...list, given];
    have['rating'] = merged.slice(-RATINGS_MAX);
  }
  return have;
}

export function renderReport(input: RenderInput): Report {
  const types = included(input);
  // The header is required to send anything: without it a report cannot be validated.
  if (!types.some((type) => type.id === 'header')) return EMPTY;

  const json: Record<string, unknown> = { catalog_version: input.catalog.catalogVersion };
  const noData: Array<{ readonly title: string; readonly fields: string[] }> = [];
  const collected = new Map<string, Record<string, unknown>>();
  for (const type of types) {
    const have = valuesOf(input, type.id);
    collected.set(type.id, have);
    const missing: string[] = [];
    for (const field of type.fields) {
      if (field.name === 'catalog_version') continue;
      const wanted = field.name === 'atlas_version' ? input.version : have[field.name];
      const value = wanted !== undefined && valueFits(field.kind, wanted) ? wanted : null;
      json[field.name] = value;
      if (value === null) missing.push(field.name);
    }
    if (missing.length > 0) noData.push({ title: type.title, fields: missing });
  }

  const platform = collected.get('platform');
  const family = typeof platform?.['os_family'] === 'string' && OS_FAMILIES.includes(platform['os_family']) ? platform['os_family'] : undefined;
  const major = typeof platform?.['os_major'] === 'number' && Number.isInteger(platform['os_major']) ? ` ${String(platform['os_major'])}` : '';
  const rating = collected.has('ratings') && input.rating !== undefined && ABOUT.test(input.rating.about) ? input.rating : undefined;

  const title = [
    `[diagnostics] atlas ${input.version}`,
    ...(family === undefined ? [] : [`${family}${major}`]),
    ...(rating === undefined ? [] : [`${ratingSymbol(rating.value)} ${rating.about}`]),
  ].join(' · ');
  const labels = ['diagnostics', ...(rating === undefined ? [] : [RATING_LABEL[rating.value]]), ...(family === undefined ? [] : [`os:${family.toLowerCase()}`])];

  const lines = [
    `Diagnostics report from gsd-atlas ${input.version}, catalog version ${String(input.catalog.catalogVersion)}. It holds only the data types the user who built it approved:`,
    '',
    ...types.map((type) => `- ${type.title}`),
    ...(noData.length === 0 ? [] : ['', 'No data yet (reported as null):', ...noData.map((entry) => `- ${entry.title}: ${entry.fields.join(', ')}`)]),
    '',
    '```diagnostics-v1',
    // A backtick can only sit inside a JSON string; its escape keeps any value from closing the fence.
    JSON.stringify(json, null, 2).replaceAll('`', '\\u0060'),
    '```',
  ];
  return { title, labels, body: `${lines.join('\n')}\n`, json };
}
