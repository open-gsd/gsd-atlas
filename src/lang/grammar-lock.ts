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

/**
 * `generate` (upstream only, default true when absent): false builds the WASM from the
 * `src/parser.c` the pinned archive already ships and skips `tree-sitter generate`. Needed when
 * generate cannot run from the archive alone (tree-sitter-typescript's grammar.js requires
 * tree-sitter-javascript on disk) or when the archive's parser.c is the reviewed artifact.
 */
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
  generate: z.boolean().optional(),
});

/**
 * The closed set of build platforms a lock can pin: `${process.platform}-${process.arch}`. A
 * platform outside this set cannot be verified at all, and a platform inside it with no entry in
 * `wasm.platforms` fails verification with a diagnostic; neither ever passes silently.
 */
export const PLATFORM_KEYS = [
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'win32-arm64',
] as const;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

/**
 * Platforms whose build is the committed artifact. Their toolchain output is byte-identical (CI
 * evidence on BASE cc2f19ab: linux-x64 and darwin-arm64 both 16237 bytes, same sha256), and
 * `--update-lock` (which replaces the committed wasm) is only allowed on one of them. Other
 * platforms record their own rebuild hash with `--update-platform` and never touch the artifact.
 */
export const ARTIFACT_PLATFORM_KEYS: readonly PlatformKey[] = ['linux-x64', 'darwin-arm64'];

/** Map a Node platform/arch pair to its lock key, or undefined when it is outside the closed set. */
export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return (PLATFORM_KEYS as readonly string[]).includes(key) ? (key as PlatformKey) : undefined;
}

/**
 * lockVersion 2 (lockVersion 1 had a single `wasm.sha256` and was verified on every OS, which
 * the first CI run refuted for win32: the Windows toolchain emits different wasm bytes).
 *
 * - `wasm.sha256` is the hash of the file at `wasm.file`: the committed, shipped artifact. The
 *   engine and the module reader check the wasm they load against this value and nothing else.
 * - `wasm.platforms` maps a platform key to the hash a rebuild from source produces on that
 *   platform. Each OS verifies its own rebuild against its own entry. At least one entry must
 *   equal `wasm.sha256`, so the committed artifact is always reproducible somewhere.
 */
const PlatformHashes = z
  .partialRecord(z.enum(PLATFORM_KEYS), Sha256)
  .refine((platforms) => Object.keys(platforms).length > 0, {
    message: 'must have at least one platform entry',
  });

export const GrammarLockSchema = z
  .strictObject({
    lockVersion: z.literal(2, {
      error: 'must be 2 (lockVersion 1 locks have no per-platform hashes; regenerate with --update-lock)',
    }),
    name: z.string().min(1),
    source: z.discriminatedUnion('type', [LocalSource, UpstreamSource]),
    patches: z.array(RelativePath),
    license: z.string().min(1),
    cli: z.strictObject({ version: z.string().regex(SEMVER_TRIPLE, 'must be digits.digits.digits') }),
    abi: z.number().int().positive(),
    wasm: z.strictObject({
      file: RelativePath,
      sha256: Sha256,
      platforms: PlatformHashes,
    }),
  })
  .superRefine((lock, ctx) => {
    if (!Object.values(lock.wasm.platforms).includes(lock.wasm.sha256)) {
      ctx.addIssue({
        code: 'custom',
        path: ['wasm', 'platforms'],
        message: 'no platform entry equals wasm.sha256, so the committed wasm is not reproducible from source on any platform',
      });
    }
  });

export type GrammarLock = z.infer<typeof GrammarLockSchema>;

export type PlatformExpectation =
  | { readonly ok: true; readonly key: PlatformKey; readonly sha256: string }
  | { readonly ok: false; readonly key: PlatformKey | undefined; readonly message: string };

/**
 * The hash a rebuild on `platform`/`arch` must produce. Strict: a platform outside the closed
 * set, or inside it with no entry, is a failure that names the platform key and the
 * `--update-platform` / `--update-lock` hint, never a pass.
 */
export function expectedPlatformSha256(
  lock: GrammarLock,
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformExpectation {
  const key = platformKey(platform, arch);
  if (key === undefined) {
    return {
      ok: false,
      key,
      message:
        `${lock.name}: ${platform}-${arch} is not a supported grammar build platform ` +
        `(supported: ${PLATFORM_KEYS.join(', ')})`,
    };
  }
  const sha256 = lock.wasm.platforms[key];
  if (sha256 === undefined) {
    const recorded = Object.keys(lock.wasm.platforms).join(', ');
    return {
      ok: false,
      key,
      message:
        `${lock.name}: grammar.lock has no wasm.platforms entry for ${key} (recorded: ${recorded}); ` +
        'run node scripts/grammar-build.ts --update-platform <moduleDir> on this platform to record it',
    };
  }
  return { ok: true, key, sha256 };
}

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
