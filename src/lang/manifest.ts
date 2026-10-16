// RED stub (plan 01-06 task 2): replaced by the real schema in the GREEN commit.
import type { Diagnostic } from '../facts/index.ts';

export const MANIFEST_SCHEMA_VERSION = 1;

export type Manifest = {
  $schema?: string;
  schemaVersion: 1;
  name: string;
  version?: string;
  extensions: string[];
  replace?: boolean;
  grammar: { wasm: string; lock: string };
  queries: { tags: string; refs?: string; imports?: string };
  tiers: Array<'grammar' | 'precise' | 'platform'>;
  parseBudget: number;
  testGlobs?: string[];
  features?: string;
  project?: { markers?: string[]; model?: string };
  precise?: { command: string[] } | { adapter: string };
};

export function parseManifest(
  _json: unknown,
  _subject?: string,
): { ok: true; manifest: Manifest } | { ok: false; diagnostics: Diagnostic[] } {
  return { ok: false, diagnostics: [] };
}
