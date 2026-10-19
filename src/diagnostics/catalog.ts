/**
 * The diagnostics catalog (docs/DIAGNOSTICS.md section 3; docs/adr/15-user-controlled-diagnostics.md, decision 2): the
 * published list of data types a report can hold. It ships with the package as `diagnostics/catalog.v1.json`, and
 * the CLI and the later intake bot both validate against it. A type lists its fields with an example, how it helps
 * the project and what it cannot reveal; the user approves a type as a whole.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readBounded } from './io.ts';
import type { DiagnosticsFs } from './io.ts';

/** The catalog version this build ships and reports in every header. */
export const CATALOG_VERSION = 1;

/** The file inside the catalog folder. */
export const CATALOG_FILE = 'catalog.v1.json';

/** The largest catalog file read, in bytes. */
export const CATALOG_MAX_BYTES = 256 * 1024;

/** How a field's value is shaped; a report value that does not fit its kind is replaced by null. */
export const FIELD_KINDS = ['string', 'integer', 'number', 'bucket', 'list', 'map', 'text'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

const NAME = /^[a-z][a-z0-9_]{0,47}$/;

const FieldSchema = z.strictObject({
  name: z.string().regex(NAME),
  example: z.string().max(300),
  kind: z.enum(FIELD_KINDS),
});

const TypeSchema = z
  .strictObject({
    id: z.string().regex(NAME),
    title: z.string().min(1).max(80),
    required: z.boolean().optional(),
    fields: z.array(FieldSchema).min(1).max(32),
    howItHelps: z.string().min(1).max(4000),
    cannotReveal: z.string().min(1).max(1000),
  })
  .superRefine((type, context) => {
    const seen = new Set<string>();
    for (const field of type.fields) {
      if (seen.has(field.name)) context.addIssue({ code: 'custom', path: ['fields'], message: 'duplicate field name' });
      seen.add(field.name);
    }
  });

/** The strict schema of the whole catalog file: an unknown key anywhere, or a type without its explanation, is refused. */
export const CatalogSchema = z
  .strictObject({
    catalogVersion: z.int().positive(),
    types: z.array(TypeSchema).min(1).max(64),
  })
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const type of catalog.types) {
      if (ids.has(type.id)) context.addIssue({ code: 'custom', path: ['types'], message: 'duplicate type id' });
      ids.add(type.id);
      for (const field of type.fields) {
        // The report is one flat JSON object, so a field name belongs to exactly one type.
        if (names.has(field.name)) context.addIssue({ code: 'custom', path: ['types'], message: 'field name used by two types' });
        names.add(field.name);
      }
    }
  });

export type Catalog = z.infer<typeof CatalogSchema>;
export type CatalogType = Catalog['types'][number];
export type CatalogField = CatalogType['fields'][number];

export type ParsedCatalog = { readonly ok: true; readonly catalog: Catalog } | { readonly ok: false; readonly reason: string };

/** Check `input` against the strict schema. The reason is the first problem, with the schema's own key names. */
export function parseCatalog(input: unknown): ParsedCatalog {
  const parsed = CatalogSchema.safeParse(input);
  if (parsed.success) return { ok: true, catalog: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? 'the file' : issue.path.map(String).join('.');
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid'}` };
}

/** The folder the catalog ships in: `diagnostics/` at the package root, two levels up from `src/diagnostics` or `dist/diagnostics`. */
export function defaultCatalogDir(): string {
  return path.resolve(import.meta.dirname, '..', '..', 'diagnostics');
}

/**
 * Read and validate the catalog in `dir`. The catalog is shipped data, so a problem with it is a bug of the build, not of the
 * user: it throws, and nothing partial is ever returned.
 */
export function loadCatalog(dir: string, file: string = CATALOG_FILE, io: DiagnosticsFs = fs): Catalog {
  const read = readBounded(io, path.join(dir, file), CATALOG_MAX_BYTES);
  if (read.kind === 'missing') throw new Error('The diagnostics catalog file is missing.');
  if (read.kind === 'refused') throw new Error(`The diagnostics catalog file was refused: ${read.why}.`);
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    throw new Error('The diagnostics catalog file is not valid JSON.');
  }
  const parsed = parseCatalog(json);
  if (!parsed.ok) throw new Error(`The diagnostics catalog file is invalid: ${parsed.reason}.`);
  return parsed.catalog;
}

/** The value of a field fits its kind: `null` always fits (no data yet). */
export function valueFits(kind: FieldKind, value: unknown): boolean {
  if (value === null) return true;
  switch (kind) {
    case 'string':
    case 'bucket':
    case 'text':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'list':
      return Array.isArray(value);
    case 'map':
      return typeof value === 'object' && !Array.isArray(value);
  }
}
