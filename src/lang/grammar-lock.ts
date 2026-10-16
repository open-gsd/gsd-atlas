import { z } from 'zod';
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';

/**
 * grammar.lock: the per-module record of how a grammar WASM is built and what its bytes hash to.
 * One shared build script (scripts/grammar-build.ts) reads it for every module (D-08).
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SEMVER_TRIPLE = /^\d+\.\d+\.\d+$/;

/** A module-relative path: no leading slash, drive letter, backslash, NUL or `..` segment. */
function isSafeRelativePath(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  if (value.includes('\\') || value.includes('\0')) {
    return false;
  }
  return !value.split('/').includes('..');
}

const RelativePath = z.string().refine(isSafeRelativePath, {
  message: 'must be a relative path with no leading slash, drive letter, backslash, NUL or .. segment',
});

const Sha256 = z.string().regex(SHA256_HEX, 'must be 64 lowercase hex characters');

const LocalSource = z.strictObject({
  type: z.literal('local'),
  path: RelativePath,
});

const UpstreamSource = z.strictObject({
  type: z.literal('upstream'),
  url: z
    .string()
    .refine((u) => u.startsWith('https://') || u.startsWith('file://'), {
      message: 'must start with https:// or file:// (never plain http)',
    }),
  ref: z.string().min(1),
  archiveSha256: Sha256,
  subdir: RelativePath.optional(),
});

export const GrammarLockSchema = z.strictObject({
  lockVersion: z.literal(1),
  name: z.string().min(1),
  source: z.discriminatedUnion('type', [LocalSource, UpstreamSource]),
  patches: z.array(RelativePath),
  license: z.string().min(1),
  cli: z.strictObject({ version: z.string().regex(SEMVER_TRIPLE, 'must be digits.digits.digits') }),
  abi: z.number().int().positive(),
  wasm: z.strictObject({
    file: RelativePath,
    sha256: Sha256,
  }),
});

export type GrammarLock = z.infer<typeof GrammarLockSchema>;

export type GrammarLockResult =
  | { readonly ok: true; readonly lock: GrammarLock }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

function lockInvalid(message: string, subject: string | undefined): Diagnostic {
  return diagnostic('lock_invalid', 'warning', message, subject);
}

/**
 * Validate a grammar.lock. Accepts parsed JSON or the raw JSON text. Never throws: every
 * problem becomes a `lock_invalid` diagnostic whose subject is the caller-supplied path.
 */
export function parseGrammarLock(json: unknown, subject?: string): GrammarLockResult {
  let value: unknown = json;
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, diagnostics: [lockInvalid(`grammar.lock is not valid JSON: ${reason}`, subject)] };
    }
  }
  const parsed = GrammarLockSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, lock: parsed.data };
  }
  const diagnostics = parsed.error.issues.map((issue) => {
    const where = issue.path.length === 0 ? '(root)' : issue.path.join('.');
    return lockInvalid(`${where}: ${issue.message}`, subject);
  });
  return { ok: false, diagnostics };
}
