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
import { bucketBytes, bucketMs } from './bucket.ts';
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
  /** The recorder excerpt: events considered (the newest `excerptEvents`) and events kept after trimming to the byte cap. */
  readonly eventsTotal?: number;
  readonly eventsKept?: number;
}

/** The fields {@link renderPreview} frames a bundle's text with. */
export interface PreviewInput {
  readonly mode: Mode;
  readonly text: string;
  readonly digest: string;
  readonly included: readonly BugType[];
  /** Set when the recorder excerpt was cut to fit the byte cap. */
  readonly trimmed?: { readonly kept: number; readonly total: number } | undefined;
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
  if (input.trimmed !== undefined) lines.push(`excerpt trimmed to ${String(input.trimmed.kept)} of ${String(input.trimmed.total)} events`);
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

// ---------------------------------------------------------------------------------------------------------------------
// The forensic types. Every string that came from the recorder or the Host is checked against the closed shape it should
// have before it becomes a `code` leaf; anything else becomes a name (hashed) or `unknown`, so a value that is not what it
// should be can cost a token and never a leak.
// ---------------------------------------------------------------------------------------------------------------------

const TOOL_PATTERN = /^(?:code|atlas|lang)_[a-z]{1,16}$/;
const OUTCOME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const LATENCY_PATTERN = /^(?:le[0-9]{1,5}|inf)$/;
const SCHEMA_PATTERN = /^gsd-atlas\.[a-z0-9-]{1,40}\/[0-9]{1,3}$/;
const ANSWER_PATTERN = /^a_[0-9a-f]{16}$/;
const WORD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ARGUMENT_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

/** Codes kept in one list, and the paths kept in one `fresh` argument. */
const LIST_MAX = 16;
const PATHS_MAX = 20;
const HANDLES_MAX = 20;
/** Explanations of the failing answer's facts (`code_explain` summarises five). */
const FACTS_MAX = 5;

const UNKNOWN = leaf.code('unknown');

/** A fixed word of the closed shape `pattern`, else `unknown`. */
const closed = (value: string | undefined, pattern: RegExp): Tree => (typeof value === 'string' && pattern.test(value) ? leaf.code(value) : UNKNOWN);

const codes = (values: readonly string[] | undefined): Tree[] =>
  (values ?? [])
    .filter((value): value is string => typeof value === 'string' && OUTCOME_PATTERN.test(value))
    .slice(0, LIST_MAX)
    .map((value) => leaf.code(value));

/** A tool the program has (`code_find`, `atlas_status`) is a word; anything else is somebody's name. */
const toolOf = (tool: string | undefined): Tree => (typeof tool !== 'string' ? UNKNOWN : TOOL_PATTERN.test(tool) ? leaf.code(tool) : leaf.name(tool));

const count = (value: number | undefined): Tree => leaf.count(typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);

type ArgumentKind = 'name' | 'path' | 'handle' | 'code' | 'count' | 'paths';

/**
 * The request arguments atlas's tools take, and how each is typed. A key that is not here, and a value that is not of the
 * type its key says, is counted in `other_args` and never shown: the recorder keeps whatever a caller sent, and neither a
 * key nor a value of an unknown shape is allowed to carry text out.
 */
const ARGUMENT_KINDS: Readonly<Record<string, ArgumentKind>> = {
  name: 'name',
  adr: 'name',
  path: 'path',
  repo: 'path',
  cwd: 'path',
  handle: 'handle',
  more: 'handle',
  answer_id: 'code',
  kind: 'code',
  mode: 'code',
  limit: 'count',
  depth: 'count',
  budget_tokens: 'count',
  fresh: 'paths',
};

function argumentsTree(args: Readonly<Record<string, unknown>> | undefined): Tree {
  const out: { [key: string]: Tree } = {};
  let other = 0;
  for (const [key, value] of Object.entries(args ?? {})) {
    const kind = Object.hasOwn(ARGUMENT_KINDS, key) ? ARGUMENT_KINDS[key] : undefined;
    if (kind === undefined) {
      other += 1;
    } else if (kind === 'count') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = count(value);
      else other += 1;
    } else if (kind === 'paths') {
      if (Array.isArray(value) && value.every((each): each is string => typeof each === 'string')) out[key] = value.slice(0, PATHS_MAX).map((each) => leaf.path(each));
      else other += 1;
    } else if (typeof value !== 'string') {
      other += 1;
    } else if (kind === 'code') {
      out[key] = ARGUMENT_CODE_PATTERN.test(value) ? leaf.code(value) : leaf.name(value);
    } else {
      out[key] = leaf[kind](value);
    }
  }
  if (other > 0) out['other_args'] = count(other);
  return out;
}

const unavailable: Tree = { status: leaf.code('unavailable') };

function configTree(config: ConfigFacts): Tree {
  const { indexer } = config;
  return {
    ...(config.storeDirSet === true ? { store: { dir: leaf.code('<path>') } } : {}),
    ...(indexer === undefined || (indexer.debounceMs === undefined && indexer.maxWaitMs === undefined)
      ? {}
      : {
          indexer: {
            ...(indexer.debounceMs === undefined ? {} : { debounceMs: count(indexer.debounceMs) }),
            ...(indexer.maxWaitMs === undefined ? {} : { maxWaitMs: count(indexer.maxWaitMs) }),
          },
        }),
    ...(config.gcGraceMs === undefined ? {} : { gc: { graceMs: count(config.gcGraceMs) } }),
    ...(config.allowCount === undefined ? {} : { permissions: { allowCount: count(config.allowCount) } }),
    ...(config.providersDisabled === undefined ? {} : { providers: { disabled: config.providersDisabled.slice(0, LIST_MAX).map((id) => leaf.code(id)) } }),
    ...(config.metrics === undefined ? {} : { metrics: config.metrics }),
  };
}

function versionsTree(data: VersionsData | null | undefined): Tree {
  if (data === null || data === undefined) return unavailable;
  const compiler = data.typescript;
  return {
    atlas: leaf.code(data.atlas),
    node: leaf.code(data.node),
    sqlite: leaf.code(data.sqlite),
    driver: leaf.code(data.driver),
    modules: data.modules.slice(0, LIST_MAX * 4).map((entry) => ({
      // A built-in module's name is a fixed word; any other module is the user's own and is named like any other name.
      name: entry.builtin ? leaf.code(entry.name) : leaf.name(entry.name),
      version: leaf.code(entry.version),
      schema_version: count(entry.schemaVersion),
    })),
    typescript:
      compiler === null
        ? { status: leaf.code('unknown') }
        : {
            version: leaf.code(compiler.version),
            source: leaf.code(compiler.source),
            case: leaf.code(compiler.case),
            ...(compiler.reason === undefined ? {} : { reason: leaf.text(compiler.reason) }),
          },
    config_effective: configTree(data.config),
    policy_mode: leaf.code('none'),
  };
}

const bucketed = (label: string | null): Tree => leaf.code(label ?? 'unknown');

function healthTree(data: HealthData | null | undefined): Tree {
  if (data === null || data === undefined) return unavailable;
  const { store, host, indexer, governor, startup, tier } = data;
  return {
    store:
      store === null
        ? unavailable
        : {
            schema_version: count(store.schemaVersion),
            worktrees: count(store.worktrees),
            size: bucketed(bucketBytes(store.sizeBytes)),
            writer_lease_held: store.writerLeaseHeld,
            rebuilt_after_corruption: store.rebuiltAfterCorruption,
          },
    host: { tenants_loaded: count(host.tenantsLoaded), transport: leaf.code(host.transport), uptime: bucketed(bucketMs(host.uptimeMs)) },
    ...(indexer === null
      ? {}
      : {
          indexer: {
            watch_mode: leaf.code(indexer.watchMode),
            queued: count(indexer.queued),
            running: count(indexer.running),
            failed: count(indexer.failed),
            reconciling: indexer.reconciling,
          },
        }),
    ...(indexer?.lastReconcile === null || indexer?.lastReconcile === undefined
      ? {}
      : { reconcile: { changed: count(indexer.lastReconcile.changed), duration: bucketed(bucketMs(indexer.lastReconcile.durationMs)) } }),
    ...(governor === null ? {} : { governor: { queued: count(governor.queued), running: count(governor.running) } }),
    ...(startup === null ? {} : { startup: leaf.code(startup) }),
    ...(tier === null ? {} : { tier: { precise: leaf.code(tier.precise), ...(tier.code === undefined ? {} : { code: leaf.code(tier.code) }) } }),
  };
}

/** The seconds between an event and the newest one, as the example in DIAGNOSTICS 9.3 writes it: `-4.2s`. */
const beforeNewest = (newest: number, at: number): string => `-${(Math.max(0, newest - at) / 1000).toFixed(1)}s`;

function eventTree(event: RecorderEvent, newest: number): Tree {
  return {
    t: leaf.code(Number.isFinite(event.t) ? beforeNewest(newest, event.t) : 'unknown'),
    tool: toolOf(event.tool),
    args: argumentsTree(event.args),
    outcome: closed(event.outcome, OUTCOME_PATTERN),
    ms: closed(event.ms, LATENCY_PATTERN),
    degraded: codes(event.degraded),
    count: count(event.count),
    handles: (event.handles ?? []).filter((handle): handle is string => typeof handle === 'string').slice(0, HANDLES_MAX).map((handle) => leaf.handle(handle)),
  };
}

/** The newest `limit` events of the recorder (oldest first), the ones the excerpt considers. */
const consideredOf = (data: RecorderData, limit: number): readonly RecorderEvent[] => (limit <= 0 ? [] : data.events.slice(-limit));

function recorderTree(considered: readonly RecorderEvent[], keep: number): Tree {
  const newest = considered[considered.length - 1]?.t ?? 0;
  const kept = keep <= 0 ? [] : considered.slice(considered.length - keep);
  return { total: count(considered.length), kept: count(kept.length), events: kept.map((event) => eventTree(event, newest)) };
}

function factTree(fact: FactSummary): Tree {
  const kind = fact.extractor?.split(':', 1)[0];
  return {
    handle: leaf.handle(fact.handle),
    status: closed(fact.status, WORD_PATTERN),
    ...(fact.kind === undefined ? {} : { kind: closed(fact.kind, WORD_PATTERN) }),
    ...(fact.tier === undefined ? {} : { tier: closed(fact.tier, WORD_PATTERN) }),
    ...(fact.confidence === undefined ? {} : { confidence: closed(fact.confidence, WORD_PATTERN) }),
    // `grammar:<module>@<version>`: the module is somebody's name, so only the tier word is shown.
    ...(fact.extractor === undefined ? {} : { extractor: kind === 'grammar' || kind === 'precise' ? leaf.code(kind) : UNKNOWN }),
    ...(fact.cache === undefined ? {} : { cache: closed(fact.cache, WORD_PATTERN) }),
  };
}

function failingTree(data: FailingData | null | undefined): Tree {
  if (data === null || data === undefined) return unavailable;
  const event = data.event;
  if (data.status === 'answer_not_found' || event === undefined) return { status: leaf.code('answer_not_found') };
  const failed = event.outcome !== undefined && event.outcome !== 'ok';
  return {
    ...(typeof event.id === 'string' && ANSWER_PATTERN.test(event.id) ? { answer_id: leaf.code(event.id) } : {}),
    tool: toolOf(event.tool),
    request: argumentsTree(event.args),
    envelope: {
      schema: closed(event.schema, SCHEMA_PATTERN),
      ok: event.outcome === 'ok',
      degraded: codes(event.degraded),
      diagnostics: codes(event.diag ?? (failed ? [event.outcome as string] : [])),
      citations: count(event.count),
      ...(typeof event.seq === 'number' ? { watermark_seq: count(event.seq) } : {}),
    },
    explain: (data.facts ?? []).slice(0, FACTS_MAX).map(factTree),
  };
}

interface Serialised {
  readonly bundle: { [key: string]: Json };
  readonly text: string;
  readonly bytes: number;
}

/** Build the bundle, its digest and its preview from one sanitised tree. */
export function buildBundle(input: BugInput): BuiltBundle {
  const hasher = input.hasher ?? createHasher();
  const included = BUG_TYPES.filter((id) => input.include.includes(id));
  const excerpt = input.excerptEvents ?? BUG_DEFAULTS.excerptEvents;
  const maxBytes = input.bundleMaxBytes ?? BUG_DEFAULTS.bundleMaxBytes;
  const considered = included.includes('recorder') && input.recorder !== null && input.recorder !== undefined ? consideredOf(input.recorder, excerpt) : null;

  const serialise = (keep: number): Serialised => {
    const tree: { [key: string]: Tree } = {
      format: leaf.code(BUNDLE_FORMAT),
      header: { atlas_version: leaf.code(input.atlasVersion), catalog_version: leaf.count(input.catalogVersion) },
      problem: problemTree(input.problem, included.includes('problem')),
    };
    if (included.includes('versions')) tree['versions'] = versionsTree(input.versions);
    if (included.includes('health')) tree['health'] = healthTree(input.health);
    if (included.includes('recorder')) tree['recorder'] = considered === null ? unavailable : recorderTree(considered, keep);
    if (included.includes('failing')) tree['failing'] = failingTree(input.failing);
    const bundle = sanitize(tree, input.mode, hasher) as { [key: string]: Json };
    const text = `${JSON.stringify(bundle, null, 2)}\n`;
    return { bundle, text, bytes: Buffer.byteLength(text, 'utf8') };
  };

  // Oldest events are dropped first until the bundle fits: the largest `keep` whose bytes are within the cap (the size only
  // grows with `keep`, so a bisection finds it). If even no event fits, the bundle is written with none rather than refused.
  let keep = considered?.length ?? 0;
  let built = serialise(keep);
  if (considered !== null && built.bytes > maxBytes) {
    let low = 0;
    let high = keep - 1;
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (serialise(middle).bytes <= maxBytes) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    keep = best;
    built = serialise(keep);
  }

  const digest = crypto.createHash('sha256').update(built.text).digest('hex');
  const trimmed = considered !== null && keep < considered.length ? { kept: keep, total: considered.length } : undefined;
  return {
    bundle: built.bundle,
    text: built.text,
    preview: renderPreview({ mode: input.mode, text: built.text, digest, included, trimmed }),
    digest,
    included,
    ...(considered === null ? {} : { eventsTotal: considered.length, eventsKept: keep }),
  };
}
