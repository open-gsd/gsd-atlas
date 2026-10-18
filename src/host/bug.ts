/**
 * `bug` (SKL-04, D-17; docs/DIAGNOSTICS.md section 9; the draft user-controlled-diagnostics ADR): the Host's request kind
 * for `gsd-atlas bug`. The CLI only sends requests; the Host gathers what the person approved and calls
 * `src/diagnostics`, which shapes the bundle.
 *
 * It is a two-step request, like `allow`, so that what the person read is exactly what is written:
 *   - `collect` builds the bundle IN MEMORY and returns the preview and the sha256 of the bytes. It writes nothing.
 *   - `write` carries that digest as `confirm`. The Host looks the collected bundle up by digest, checks that this call's
 *     arguments are the ones that were collected, and writes exactly the bytes that were previewed. The per-bundle hashing
 *     key is random, so a bundle cannot be rebuilt: it is kept from `collect` to `write`, which also means a changed
 *     argument cannot ride on an earlier "yes".
 *   - `clear` empties the repository's flight recorder.
 *
 * What this kind never does: it never touches a network, never uploads, and never includes a type the person did not
 * approve. It is a person's request: a Host started for MCP refuses the whole kind. Bundles go to
 * `<cache root>/gsd-atlas/bug-reports/<id>/` (folders 0700, files 0600) and are never overwritten.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BUG_DEFAULTS,
  BUG_TYPES,
  BUG_TYPE_INFO,
  MODES,
  buildBundle,
  createHasher,
  defaultCatalogDir,
  loadCatalog,
} from '../diagnostics/index.ts';
import type { BugType, DiagnosticsFs, Hasher, Mode, RandomSource } from '../diagnostics/index.ts';
import { ANSWER_ID_PATTERN, okEnvelope } from '../facts/index.ts';
import type { Clock, Envelope, Request } from '../facts/index.ts';
import { errorEnvelope } from '../query/index.ts';
import { RATING_FEATURES, RATING_VALUES } from '../tenant/index.ts';
import { firstProblem } from './route.ts';
import type { Selection } from './route.ts';

/** The request kind, and the one Governor key its requests run under. */
export const BUG_KIND = 'bug';

/** Envelope schema of a `bug` reply. */
export const BUG_SCHEMA = 'gsd-atlas.bug/1';

/** Where bundles go, below the Host's cache root: a folder of atlas's own, never a generic one in a shared cache. */
export const BUG_REPORTS_PATH: readonly string[] = ['gsd-atlas', 'bug-reports'];

/** The files of a bundle folder. */
export const BUNDLE_FILE = 'bundle.json';
export const PREVIEW_FILE = 'preview.txt';

/** The most characters of one of the person's own text fields; the bundle scrubs and cuts it further. */
const TEXT_MAX_CHARS = 10_000;

/** A collected bundle waits this long for its confirmation, and at most this many wait at once. */
const PENDING_TTL_MS = 30 * 60_000;
const PENDING_MAX = 16;

const text = z.string().max(TEXT_MAX_CHARS);
const selection = { repo: z.string().min(1).optional(), cwd: z.string().min(1).optional() };

const argsSchema = z
  .strictObject({
    action: z.enum(['collect', 'write', 'clear']),
    ...selection,
    what: text.optional(),
    expected: text.optional(),
    steps: text.optional(),
    feature: z.enum(RATING_FEATURES).optional(),
    rating: z.enum(RATING_VALUES).optional(),
    answer: z.string().regex(ANSWER_ID_PATTERN, 'not an answer id').optional(),
    include: z.array(z.enum(BUG_TYPES)).max(BUG_TYPES.length).optional(),
    mode: z.enum(MODES).optional(),
    confirm_raw: z.boolean().optional(),
    confirm: z.string().max(128).optional(),
  })
  .superRefine((data, context) => {
    if (data.action === 'write' && data.confirm === undefined) {
      context.addIssue({ code: 'custom', path: ['confirm'], message: 'a write needs the digest of the collected bundle' });
    }
    if (data.action === 'collect' && data.confirm !== undefined) {
      context.addIssue({ code: 'custom', path: ['confirm'], message: 'only a write takes a confirmation' });
    }
    if (data.action === 'clear') {
      const extra = Object.keys(data).filter((key) => !['action', 'repo', 'cwd'].includes(key));
      if (extra.length > 0) context.addIssue({ code: 'custom', path: [extra[0] as string], message: 'clear takes only the repository selection' });
    }
  });

type BugArgs = z.infer<typeof argsSchema>;

/** A bundle that was collected and has not been written. */
export interface PendingBundle {
  /** The arguments it was collected with, in a fixed form. A write must carry the same ones. */
  readonly fingerprint: string;
  readonly text: string;
  readonly preview: string;
  readonly at: number;
}

/** The Host's memory of its bundles: collected and waiting, and written. Per Host, so two Hosts never share one. */
export interface BugState {
  readonly pending: Map<string, PendingBundle>;
  readonly written: Set<string>;
}

export const createBugState = (): BugState => ({ pending: new Map(), written: new Set() });

/** What the Host supplies: it alone knows the version, the cache root and where the data comes from. */
export interface BugDeps {
  /** The version of this build; it is the bundle's `atlas_version`. */
  readonly version: string;
  /** The folder the shipped catalog is read from (`catalog_version` comes from it). */
  readonly catalogDir?: string | undefined;
  /** The file-system calls the module makes, so a test can make one of them fail. */
  readonly io?: DiagnosticsFs | undefined;
  /** The Host's cache root; bundles go under `gsd-atlas/bug-reports` inside it. */
  readonly cacheRoot: string;
  readonly clock: Clock;
  readonly state: BugState;
  /** `bug.excerptEvents` and `bug.bundleMaxBytes` (03-CONSTANTS.md). */
  readonly excerptEvents?: number | undefined;
  readonly bundleMaxBytes?: number | undefined;
  /** TEST HOOK. The source of the hashing key. */
  readonly random?: RandomSource | undefined;
}

const RAW_TEXT =
  'Raw mode puts real symbol names and file paths into the bundle. It needs an explicit confirmation: answer the question at a terminal, or pass --mode raw together with --confirm-raw.';
const MISMATCH = 'The confirmation does not match a bundle that was collected with these arguments, so nothing was written. Run the command again.';
const ALREADY = 'That bundle was already written. Nothing was changed; run the command again for a new one.';
const NOT_SAVED = 'The bundle could not be written to the cache directory, so nothing was saved.';
const NO_CATALOG = 'The diagnostics catalog that ships with this build could not be read.';

/** The arguments of a call in a fixed form: sorted keys, `include` sorted and unique, no `action` and no `confirm`. */
function fingerprintOf(args: BugArgs): string {
  const { action: _action, confirm: _confirm, include, ...rest } = args;
  const fixed: Record<string, unknown> = { ...rest, include: [...new Set(include ?? [])].sort() };
  return JSON.stringify(Object.fromEntries(Object.entries(fixed).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))));
}

/** The types of `include`, in the fixed order of {@link BUG_TYPES}. */
const approvedOf = (include: readonly BugType[] | undefined): BugType[] => BUG_TYPES.filter((id) => include?.includes(id) === true);

/** The folder name of a bundle: the time to the second, then the start of its digest. Names no repository. */
function bundleId(now: number, digest: string): string {
  const stamp = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  return `${stamp}-${digest.slice(0, 8)}`;
}

/** Forget collected bundles that waited too long, and the oldest ones beyond the cap. */
function tidy(state: BugState, now: number): void {
  for (const [digest, entry] of state.pending) if (now - entry.at > PENDING_TTL_MS) state.pending.delete(digest);
  while (state.pending.size >= PENDING_MAX) {
    const oldest = state.pending.keys().next();
    if (oldest.done === true) break;
    state.pending.delete(oldest.value);
  }
}

async function collect(deps: BugDeps, args: BugArgs, _chosen: Selection): Promise<Envelope> {
  const mode: Mode = args.mode ?? 'hashed';
  if (mode === 'raw' && args.confirm_raw !== true) return errorEnvelope('raw_not_confirmed', RAW_TEXT);
  let catalogVersion: number;
  try {
    catalogVersion = loadCatalog(deps.catalogDir ?? defaultCatalogDir(), undefined, deps.io).catalogVersion;
  } catch {
    return errorEnvelope('catalog_unavailable', NO_CATALOG);
  }
  const include = approvedOf(args.include);
  const hasher: Hasher = createHasher(deps.random);
  const built = buildBundle({
    atlasVersion: deps.version,
    catalogVersion,
    mode,
    include,
    problem: { what: args.what, expected: args.expected, steps: args.steps, feature: args.feature, rating: args.rating },
    excerptEvents: deps.excerptEvents ?? BUG_DEFAULTS.excerptEvents,
    bundleMaxBytes: deps.bundleMaxBytes ?? BUG_DEFAULTS.bundleMaxBytes,
    hasher,
  });
  const now = deps.clock.now();
  tidy(deps.state, now);
  deps.state.pending.set(built.digest, { fingerprint: fingerprintOf(args), text: built.text, preview: built.preview, at: now });
  return okEnvelope(BUG_SCHEMA, {
    preview: built.preview,
    digest: built.digest,
    mode,
    bytes: Buffer.byteLength(built.text, 'utf8'),
    included: built.included,
    types: BUG_TYPE_INFO,
  });
}

/** Write one file into the fresh folder: a temporary file, flushed, then a rename. The target cannot exist. */
function writeFile(io: DiagnosticsFs, dir: string, name: string, content: string): void {
  const temporary = path.join(dir, `.${name}.${String(process.pid)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let renamed = false;
  try {
    const fd = io.openSync(temporary, 'wx', 0o600);
    try {
      io.writeFileSync(fd, content);
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
    io.renameSync(temporary, path.join(dir, name));
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        io.unlinkSync(temporary);
      } catch {
        // Nothing to remove.
      }
    }
  }
}

function write(deps: BugDeps, args: BugArgs): Envelope {
  const confirm = args.confirm as string;
  const { state } = deps;
  if (state.written.has(confirm)) return errorEnvelope('already_written', ALREADY);
  const now = deps.clock.now();
  const entry = state.pending.get(confirm);
  if (entry === undefined || now - entry.at > PENDING_TTL_MS || entry.fingerprint !== fingerprintOf(args)) {
    return errorEnvelope('confirm_mismatch', MISMATCH);
  }
  // The digest names the bytes: recompute it, so a bundle can never be written under a digest it does not have.
  if (crypto.createHash('sha256').update(entry.text).digest('hex') !== confirm) return errorEnvelope('confirm_mismatch', MISMATCH);

  const io: DiagnosticsFs = deps.io ?? fs;
  const root = path.join(deps.cacheRoot, ...BUG_REPORTS_PATH);
  const dir = path.join(root, bundleId(now, confirm));
  let created = false;
  try {
    io.mkdirSync(root, { recursive: true, mode: 0o700 });
    io.mkdirSync(dir, { mode: 0o700 });
    created = true;
    writeFile(io, dir, BUNDLE_FILE, entry.text);
    writeFile(io, dir, PREVIEW_FILE, entry.preview);
  } catch (error) {
    if (!created && (error as { readonly code?: unknown }).code === 'EEXIST') {
      state.written.add(confirm);
      return errorEnvelope('already_written', ALREADY);
    }
    if (created) {
      try {
        io.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A folder that cannot be removed holds at most a complete file; the next write uses a new name.
      }
    }
    return errorEnvelope('bundle_not_saved', NOT_SAVED);
  }
  state.pending.delete(confirm);
  state.written.add(confirm);
  return okEnvelope(BUG_SCHEMA, {
    written: true,
    path: dir,
    files: [BUNDLE_FILE, PREVIEW_FILE],
    digest: confirm,
    bytes: Buffer.byteLength(entry.text, 'utf8'),
    preview: entry.preview,
  });
}

/** Answer one `bug` request. */
export async function handleBug(request: Request, deps: BugDeps): Promise<Envelope> {
  const given = request.args === undefined || request.args === null ? {} : request.args;
  if (typeof given !== 'object' || Array.isArray(given)) return errorEnvelope('invalid_args', 'args must be an object');
  const parsed = argsSchema.safeParse(given);
  if (!parsed.success) return errorEnvelope('invalid_args', firstProblem(parsed.error));
  const args = parsed.data;
  const chosen: Selection = { repo: args.repo, cwd: args.cwd };
  switch (args.action) {
    case 'collect':
      return collect(deps, args, chosen);
    case 'write':
      return write(deps, args);
    case 'clear':
      return errorEnvelope('invalid_args', 'clear is not available yet');
  }
}
