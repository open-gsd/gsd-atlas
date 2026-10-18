/**
 * The `gsd-atlas bug` bundle (SKL-04, D-17; docs/DIAGNOSTICS.md section 9; threats T-03-321 to T-03-325).
 *
 * `buildBundle` turns what the Host gathered into three things that cannot drift apart, because they are made from ONE
 * sanitised tree:
 *   - `bundle`/`text`: the bundle as JSON (format `gsd-atlas-bug-v1`), two-space indentation, fixed key order;
 *   - `digest`: the sha256 of those bytes, which the Host's second step must carry back before anything is written;
 *   - `preview`: a short framing followed by those very bytes, which is what the person reads and what `preview.txt` holds.
 *
 * What is in a bundle: always the report header (`atlas_version`, `catalog_version`) and the user's own text (scrubbed);
 * then, per type the person approved, the type's section. A type that was not approved contributes nothing, even when its
 * data was handed in, so the Host cannot leak one by gathering too much. Nothing here reads source text, `untrusted_text`,
 * ADR or documentation text: the data interfaces below have no field that could carry them.
 *
 * Pure: no file, process, database or network. The Host gathers, this module shapes.
 */
import crypto from 'node:crypto';
import { createHasher } from './hash.ts';
import type { Hasher } from './hash.ts';
import { leaf, sanitize } from './sanitize.ts';
import type { Json, Mode, Tree } from './sanitize.ts';

/** The format name written into every bundle. */
export const BUNDLE_FORMAT = 'gsd-atlas-bug-v1';

/** The types a person approves one by one (DIAGNOSTICS 9.3). Each starts denied. */
export const BUG_TYPES = ['problem', 'versions', 'health', 'recorder', 'failing'] as const;
export type BugType = (typeof BUG_TYPES)[number];

/** Source: 03-CONSTANTS.md, `bug.excerptEvents` (200) and `bug.bundleMaxBytes` (1048576); change them there first. */
export const BUG_DEFAULTS = {
  excerptEvents: 200,
  bundleMaxBytes: 1_048_576,
} as const;

/** What the person is shown about one type before approving it. */
export interface BugTypeInfo {
  readonly id: BugType;
  readonly title: string;
  readonly contains: string;
  readonly helps: string;
  readonly cannot_reveal: string;
  /** True when the type can hold names and paths of the repository, so the mode (hashed, redacted, raw) applies to it. */
  readonly names_and_paths: boolean;
}

export const BUG_TYPE_INFO: readonly BugTypeInfo[] = [
  {
    id: 'problem',
    title: 'Problem statement',
    contains: 'The feature you name and your rating (up, meh, down). The words you typed for this report (what happened, what you expected, the steps) are always in the bundle, scrubbed of paths, links, e-mail addresses and secret shapes, because they are the report.',
    helps: 'Your description is the anchor everything else is read against: without "expected X, got Y" a maintainer is guessing what is wrong.',
    cannot_reveal: 'Anything you did not write.',
    names_and_paths: false,
  },
  {
    id: 'versions',
    title: 'Versions and configuration',
    contains: 'Versions of atlas, Node and SQLite, the loaded language modules and the TypeScript compiler in use, and your user-level configuration with paths replaced by <path> and permissions reduced to a count.',
    helps: 'Most "it does not work for me" reports come down to a version or a setting the maintainer does not have.',
    cannot_reveal: 'Tokens, secrets, real paths or the commands you approved.',
    names_and_paths: false,
  },
  {
    id: 'health',
    title: 'Store and host health',
    contains: 'Counts, flags and codes: the store schema version, worktree count and size bucket, whether a writer lease is held, whether the store was rebuilt after corruption, the host state and the last reconcile.',
    helps: 'It separates "atlas gave a wrong answer" from "atlas\'s store or host was unhealthy when it answered".',
    cannot_reveal: 'Any stored fact, name or path.',
    names_and_paths: false,
  },
  {
    id: 'recorder',
    title: 'Flight recorder excerpt',
    contains: 'The newest tool calls atlas answered for this repository: the tool, the arguments, the outcome, a latency label, the degraded codes and the citation handles.',
    helps: 'It shows the sequence that led to the failure, which you rarely remember; it is usually the most useful part of a report.',
    cannot_reveal: 'In hashed mode, names and paths appear only as stable tokens. Redacted mode drops them. Raw mode shows them and is marked in the preview. Source text is never included.',
    names_and_paths: true,
  },
  {
    id: 'failing',
    title: 'Failing answer',
    contains: 'The request that gave the wrong answer, a summary of the envelope it returned (schema, ok, degraded and diagnostic codes, counts, watermark) and, for up to five of its facts, the kind, tier, confidence and extractor that explain it.',
    helps: 'A wrong reference or a missing definition is only fixable when the maintainer can see which extractor and tier produced it.',
    cannot_reveal: 'The code itself is never included. In hashed mode, names and paths are tokens.',
    names_and_paths: true,
  },
];

/** The user's own words and the two closed fields that go with them. */
export interface ProblemInput {
  readonly what?: string | undefined;
  readonly expected?: string | undefined;
  readonly steps?: string | undefined;
  readonly feature?: string | undefined;
  readonly rating?: string | undefined;
}

/** One language module the host has loaded. A built-in module's name is a fixed word; any other module's name is the user's. */
export interface ModuleVersion {
  readonly name: string;
  readonly builtin: boolean;
  readonly version: string;
  readonly schemaVersion: number;
}

/** The TypeScript compiler the precise tier uses: where it came from and why (`project` or `bundled`). */
export interface TypeScriptVersion {
  readonly version: string;
  readonly source: string;
  readonly case: string;
  readonly reason?: string | undefined;
}

/**
 * The user-level configuration as the bundle shows it. The Host reduces it before handing it in: it holds no path (a
 * directory is a boolean), no command (permissions are a count) and no secret.
 */
export interface ConfigFacts {
  /** True when the user pointed `store.dir` somewhere; the path itself is never shown. */
  readonly storeDirSet?: boolean | undefined;
  readonly indexer?: { readonly debounceMs?: number | undefined; readonly maxWaitMs?: number | undefined } | undefined;
  readonly gcGraceMs?: number | undefined;
  readonly allowCount?: number | undefined;
  readonly providersDisabled?: readonly string[] | undefined;
  readonly metrics?: boolean | undefined;
}

/** Versions and the effective configuration (DIAGNOSTICS 9.3). */
export interface VersionsData {
  readonly atlas: string;
  readonly node: string;
  readonly sqlite: string;
  readonly driver: string;
  readonly modules: readonly ModuleVersion[];
  readonly typescript: TypeScriptVersion | null;
  readonly config: ConfigFacts;
}

/** Store and host health: numbers, flags and codes only. */
export interface HealthData {
  readonly store: {
    readonly schemaVersion: number;
    readonly worktrees: number;
    readonly sizeBytes: number;
    readonly writerLeaseHeld: boolean;
    readonly rebuiltAfterCorruption: boolean;
  } | null;
  readonly host: { readonly tenantsLoaded: number; readonly transport: string; readonly uptimeMs: number };
  readonly indexer: {
    readonly watchMode: string;
    readonly queued: number;
    readonly running: number;
    readonly failed: number;
    readonly reconciling: boolean;
    readonly lastReconcile: { readonly changed: number; readonly durationMs: number } | null;
  } | null;
  readonly governor: { readonly queued: number; readonly running: number } | null;
  readonly startup: string | null;
  readonly tier: { readonly precise: string; readonly code?: string | undefined } | null;
}

/** One answer the flight recorder remembers. The recorder holds codes, counts, handles and request arguments only. */
export interface RecorderEvent {
  /** Epoch milliseconds. */
  readonly t: number;
  readonly tool?: string | undefined;
  readonly args?: Readonly<Record<string, unknown>> | undefined;
  readonly outcome?: string | undefined;
  readonly ms?: string | undefined;
  readonly degraded?: readonly string[] | undefined;
  readonly count?: number | undefined;
  readonly handles?: readonly string[] | undefined;
  /** The envelope's schema, the codes of its diagnostics and its watermark sequence number (recorded from plan 03-32). */
  readonly schema?: string | undefined;
  readonly diag?: readonly string[] | undefined;
  readonly seq?: number | undefined;
  readonly id?: string | undefined;
}

/** The recorder's newest events, oldest first. */
export interface RecorderData {
  readonly events: readonly RecorderEvent[];
}

/** What `explain` says about one fact of the failing answer. */
export interface FactSummary {
  readonly handle: string;
  readonly status: string;
  readonly kind?: string | undefined;
  readonly tier?: string | undefined;
  readonly confidence?: string | undefined;
  readonly extractor?: string | undefined;
  readonly cache?: string | undefined;
}

/** The failing answer: the recorded answer and `explain` for up to five of its facts, or the fact that it is gone. */
export interface FailingData {
  readonly status: 'ok' | 'answer_not_found';
  readonly event?: RecorderEvent | undefined;
  readonly facts?: readonly FactSummary[] | undefined;
}

/** What `BugInput` carries beyond the header and the text: data the Host gathered, shaped by the interfaces in this file. */
export interface BugInput {
  readonly atlasVersion: string;
  readonly catalogVersion: number;
  readonly mode: Mode;
  /** The types the person approved. */
  readonly include: readonly BugType[];
  readonly problem: ProblemInput;
  /** Null: the type was approved but its data could not be gathered (no index, no recorder). */
  readonly versions?: VersionsData | null | undefined;
  readonly health?: HealthData | null | undefined;
  readonly recorder?: RecorderData | null | undefined;
  readonly failing?: FailingData | null | undefined;
  /** `bug.excerptEvents` and `bug.bundleMaxBytes`; the defaults are {@link BUG_DEFAULTS}. */
  readonly excerptEvents?: number | undefined;
  readonly bundleMaxBytes?: number | undefined;
  /** The key of the hasher is the bundle's; a test passes one with a fixed key. */
  readonly hasher?: Hasher | undefined;
}

/** The result of building a bundle. */
export interface BuiltBundle {
  readonly bundle: { readonly [key: string]: Json };
  /** The exact bytes of `bundle.json`. */
  readonly text: string;
  /** The exact bytes of `preview.txt`: a framing, then `text`. */
  readonly preview: string;
  /** The sha256 of `text`, in lower-case hexadecimal. */
  readonly digest: string;
  /** The approved types that are in the bundle, in the fixed order. */
  readonly included: readonly BugType[];
}

/** The fields {@link renderPreview} frames a bundle's text with. */
export interface PreviewInput {
  readonly mode: Mode;
  readonly text: string;
  readonly digest: string;
  readonly included: readonly BugType[];
}

/** The first line of a raw-mode preview. */
export const RAW_BANNER = 'RAW MODE: names and paths are included as they are';

/**
 * The preview: a framing of a few lines, then the bundle's bytes unchanged. The framing says what the bytes are; the bytes
 * are the whole content, so what the person reads is what is written.
 */
export function renderPreview(input: PreviewInput): string {
  const lines: string[] = [];
  if (input.mode === 'raw') lines.push(RAW_BANNER);
  lines.push(
    `gsd-atlas bug bundle: format ${BUNDLE_FORMAT}, mode ${input.mode}, ${String(Buffer.byteLength(input.text, 'utf8'))} bytes, sha256 ${input.digest.slice(0, 12)}`,
  );
  lines.push(`Contains: report header, your own text${input.included.map((id) => `, ${id}`).join('')}`);
  lines.push('Nothing is uploaded. The bytes below are exactly what is written to bundle.json on this machine.');
  lines.push('----- bundle.json -----');
  return `${lines.join('\n')}\n${input.text}`;
}

const words = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** The `problem` section: the user's text always, the closed feature and rating only when the person approved the type. */
function problemTree(problem: ProblemInput, approved: boolean): Tree {
  const what = words(problem.what);
  const expected = words(problem.expected);
  const steps = words(problem.steps);
  return {
    ...(what === undefined ? {} : { what_happened: leaf.text(what) }),
    ...(expected === undefined ? {} : { expected: leaf.text(expected) }),
    ...(steps === undefined ? {} : { steps: leaf.text(steps) }),
    ...(approved && problem.feature !== undefined ? { feature: leaf.code(problem.feature) } : {}),
    ...(approved && problem.rating !== undefined ? { rating: leaf.code(problem.rating) } : {}),
  };
}

/** Build the bundle, its digest and its preview from one sanitised tree. */
export function buildBundle(input: BugInput): BuiltBundle {
  const hasher = input.hasher ?? createHasher();
  const included = BUG_TYPES.filter((id) => input.include.includes(id) && id === 'problem');
  const tree: Tree = {
    format: leaf.code(BUNDLE_FORMAT),
    header: { atlas_version: leaf.code(input.atlasVersion), catalog_version: leaf.count(input.catalogVersion) },
    problem: problemTree(input.problem, input.include.includes('problem')),
  };
  const bundle = sanitize(tree, input.mode, hasher) as { [key: string]: Json };
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  const digest = crypto.createHash('sha256').update(text).digest('hex');
  return { bundle, text, preview: renderPreview({ mode: input.mode, text, digest, included }), digest, included };
}
