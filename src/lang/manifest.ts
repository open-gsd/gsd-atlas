/**
 * The language-module manifest, schema version 1 (D-04, FND-03).
 *
 * The manifest is untrusted data authored outside the project (trust-boundaries ADR).
 * Every object is strict: an unknown field is rejected, so any field added after Phase 1
 * needs a schemaVersion bump. Nothing here executes or resolves `precise.command` or
 * `precise.adapter`; permission to run anything comes only from user-level config (T-01-14).
 *
 * Constraints are written with built-in Zod checks and `.regex()` only. Refinement
 * callbacks do not reach the generated JSON Schema, which would break the Ajv parity
 * test (D-05).
 */
import { z } from 'zod';

import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';

export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * One shared rule for every manifest-referenced path (T-01-12). A path is accepted only
 * when it is non-empty and relative, with no Windows drive letter, no backslash, no NUL
 * and no `..` segment. A regex, so the rule reaches the JSON Schema as a `pattern`.
 *
 *   (?![A-Za-z]:)                  no drive letter prefix such as C:
 *   (?!\/)                         not absolute
 *   (?!(?:[^/]*\/)*\.\.(?:\/|$))   no `..` segment anywhere
 *   [^\\\u0000]+                   non-empty, no backslash, no NUL
 */
const RELATIVE_ASSET_PATH = /^(?![A-Za-z]:)(?!\/)(?!(?:[^/]*\/)*\.\.(?:\/|$))[^\\\u0000]+$/;

const relativeAssetPath = z
  .string()
  .regex(RELATIVE_ASSET_PATH, 'must be a relative path with no drive letter, backslash or ".." segment');

const kebabName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'must be lower-case kebab-case starting with a letter')
  .max(64);

const TIERS = ['grammar', 'precise', 'platform'] as const;

export const ManifestSchema = z.strictObject({
  /** Editor key; carries no meaning for the engine. */
  $schema: z.string().optional(),
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  name: kebabName,
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'must be a semantic version such as 1.2.3')
    .optional(),
  extensions: z
    .array(z.string().regex(/^\.[A-Za-z0-9]+$/, 'must look like ".ext"'))
    .min(1)
    .max(32),
  /** This module intentionally replaces another module claiming the same extension. */
  replace: z.boolean().optional(),
  grammar: z.strictObject({
    wasm: relativeAssetPath,
    lock: relativeAssetPath,
  }),
  queries: z.strictObject({
    tags: relativeAssetPath,
    refs: relativeAssetPath.optional(),
    imports: relativeAssetPath.optional(),
  }),
  tiers: z.array(z.enum(TIERS)).min(1).default(['grammar']),
  parseBudget: z.number().min(0).max(1).default(0.005),
  testGlobs: z.array(z.string()).optional(),
  features: relativeAssetPath.optional(),
  project: z
    .strictObject({
      markers: z.array(z.string()).optional(),
      model: kebabName.optional(),
    })
    .optional(),
  /** Data only: never executed or resolved by the manifest parser (T-01-14). */
  precise: z
    .union([
      z.strictObject({ command: z.array(z.string().min(1)).min(1) }),
      z.strictObject({ adapter: kebabName }),
    ])
    .optional(),
});

export type Manifest = z.output<typeof ManifestSchema>;

export type ParseManifestResult =
  | { readonly ok: true; readonly manifest: Manifest }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

function issueLabel(issue: z.core.$ZodIssue): string {
  const join = (path: readonly PropertyKey[]): string => path.map(String).join('.');
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => join([...issue.path, key])).join(', ');
  }
  return issue.path.length === 0 ? 'manifest' : join(issue.path);
}

/**
 * Validate a decoded manifest. Never throws: any input yields either the manifest with
 * defaults applied or one `manifest_invalid` warning per issue (the module is skipped and
 * the command continues). `subject` names the module path the caller read it from.
 */
export function parseManifest(json: unknown, subject?: string): ParseManifestResult {
  try {
    const parsed = ManifestSchema.safeParse(json);
    if (parsed.success) return { ok: true, manifest: parsed.data };
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) =>
        diagnostic('manifest_invalid', 'warning', `${issueLabel(issue)}: ${issue.message}`, subject),
      ),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [
        diagnostic('manifest_invalid', 'warning', `manifest: could not be read (${reason})`, subject),
      ],
    };
  }
}
