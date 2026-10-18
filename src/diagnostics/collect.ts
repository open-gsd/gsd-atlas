/**
 * What each data type of the catalog holds on this machine (docs/DIAGNOSTICS.md section 3). Every collector is a pure
 * function over a {@link DiagnosticsSources} object, so a test needs no Host. A collector returns exactly the fields the
 * catalog lists for its type, each a bounded, closed value: a number, a fixed bucket label, a name from a closed list or
 * `null` when there is no data yet. Nothing is invented: a value the sources cannot supply is `null`.
 *
 * Never collected, in any type: source code, file paths, file, symbol, repository or branch names, remotes, commit hashes,
 * documentation or ADR text, prompts, transcripts, environment variables, user names, host names, IP addresses. That is
 * why the sources carry counts and codes, never names from a repository, and why a module is reported only when it is a
 * first-party (built-in) one: a repository or a user can name a module anything.
 */
import { bucketBytes, bucketCount, bucketLines, bucketMs, AGENT_CONCURRENCY_EDGES, REPO_COUNT_EDGES, WORKTREE_COUNT_EDGES } from './bucket.ts';
import { scrubNote } from './scrub.ts';

export interface PlatformFacts {
  /** `macOS`, `Linux`, `Windows`, or anything else (reported as `other`). */
  readonly osFamily: string;
  readonly osMajor: number | null;
  readonly nodeMajor: number | null;
}

/** A language module as the registry lists it: reported only when `source` is `builtin`. */
export interface ModuleFacts {
  readonly name: string;
  readonly source: string;
  readonly tiers: ReadonlyArray<{ readonly tier: string; readonly active: boolean }>;
}

/** The index-health gauges of the metrics report. */
export interface IndexFacts {
  readonly files: number;
  readonly errorFiles: number;
  readonly sizeBytes: number;
}

/** What the metrics report knows of the answers given: totals and the bounds of the latency histogram. */
export interface ActivityFacts {
  readonly answersTotal: number;
  readonly degradedTotal: number;
  /** Upper edge in ms of the histogram bucket holding the 50th percentile, or null with no samples. */
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
}

export interface RatingFact {
  /** A feature name from the closed rating list, or `last` or `session`. */
  readonly about: string;
  readonly value: 'up' | 'meh' | 'down';
}

/** Everything the collectors read. The Host assembles it from the tenant status, the metrics report and the registry. */
export interface DiagnosticsSources {
  readonly atlasVersion: string;
  readonly catalogVersion: number;
  readonly platform?: PlatformFacts;
  /** The agent host the Host was told about; anything outside the closed list is `unknown`. */
  readonly agentHost?: string;
  readonly transport?: string;
  readonly modules?: readonly ModuleFacts[];
  readonly index?: IndexFacts;
  readonly activity?: ActivityFacts;
  readonly repoCount?: number;
  readonly repoLines?: number;
  readonly worktreeCount?: number;
  readonly agentConcurrency?: number;
  /** The last build, in milliseconds. */
  readonly buildMs?: number;
  readonly hookP95Ms?: number;
  /** Names from {@link BUDGETS}. */
  readonly budgetBreaches?: readonly string[];
  /** Error reason code to count; a code outside the code shape is dropped. */
  readonly errorCodes?: Readonly<Record<string, number>>;
  readonly ratings?: readonly RatingFact[];
  /** The user's own words; scrubbed here, never trusted. */
  readonly note?: string;
}

export type TypeValues = Readonly<Record<string, unknown>>;

const OS_FAMILIES: readonly string[] = ['macOS', 'Linux', 'Windows'];
const AGENT_HOSTS: readonly string[] = ['claude-code', 'cursor', 'codex', 'unknown'];
const TRANSPORTS: readonly string[] = ['in-process', 'stdio', 'unix-socket', 'named-pipe'];
const TIERS: readonly string[] = ['grammar', 'precise', 'platform'];
/** The budgets a breach can name (DESIGN.md); a name outside the list is dropped. */
export const BUDGETS: readonly string[] = ['build_time', 'update_time', 'warm_query', 'store_size', 'hook_latency', 'memory'];
const RATING_SYMBOL: Readonly<Record<RatingFact['value'], string>> = { up: '↑', meh: '↔', down: '↓' };

const MODULE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
export const ABOUT = /^[a-z][a-z0-9_]{0,31}$/;

/** At most this many error codes and ratings are reported. */
const LIST_MAX = 20;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function platform(sources: DiagnosticsSources): TypeValues {
  const facts = sources.platform;
  if (facts === undefined) return { os_family: null, os_major: null, node_major: null };
  return {
    os_family: OS_FAMILIES.includes(facts.osFamily) ? facts.osFamily : 'other',
    os_major: isCount(facts.osMajor) ? facts.osMajor : null,
    node_major: isCount(facts.nodeMajor) ? facts.nodeMajor : null,
  };
}

function agentSetup(sources: DiagnosticsSources): TypeValues {
  return {
    agent_host: sources.agentHost !== undefined && AGENT_HOSTS.includes(sources.agentHost) ? sources.agentHost : 'unknown',
    transport: sources.transport === undefined ? null : TRANSPORTS.includes(sources.transport) ? sources.transport : 'unknown',
  };
}

function languages(sources: DiagnosticsSources): TypeValues {
  let active: string[] | null = null;
  let tiers: Record<string, string[]> | null = null;
  if (sources.modules !== undefined) {
    // First-party modules only: a repository or the user can name a module anything, so only a built-in one is reported.
    const builtin = sources.modules.filter((entry) => entry.source === 'builtin' && MODULE_NAME.test(entry.name));
    const live = builtin
      .map((entry) => ({ name: entry.name, tiers: entry.tiers.filter((tier) => tier.active && TIERS.includes(tier.tier)).map((tier) => tier.tier).sort() }))
      .filter((entry) => entry.tiers.length > 0)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    active = live.map((entry) => entry.name);
    tiers = Object.fromEntries(live.map((entry) => [entry.name, entry.tiers]));
  }
  const { index, activity } = sources;
  return {
    languages_active: active,
    tiers_active: tiers,
    // The metrics gauges are for the whole index, not per module, so the rate is reported under one key.
    parse_error_rate: index !== undefined && index.files > 0 ? { all: round3(Math.min(1, index.errorFiles / index.files)) } : null,
    degraded_rate: activity !== undefined && activity.answersTotal > 0 ? round3(Math.min(1, activity.degradedTotal / activity.answersTotal)) : null,
  };
}

function scale(sources: DiagnosticsSources): TypeValues {
  const count = (value: number | undefined, edges: readonly number[]): string | null => (value === undefined ? null : bucketCount(value, edges));
  return {
    repo_count_bucket: count(sources.repoCount, REPO_COUNT_EDGES),
    repo_size_bucket: sources.repoLines === undefined ? null : bucketLines(sources.repoLines),
    worktree_count_bucket: count(sources.worktreeCount, WORKTREE_COUNT_EDGES),
    agent_concurrency_bucket: count(sources.agentConcurrency, AGENT_CONCURRENCY_EDGES),
  };
}

function performance(sources: DiagnosticsSources): TypeValues {
  const { activity } = sources;
  const measured = activity !== undefined && activity.answersTotal > 0 && activity.latencyP50Ms !== null && activity.latencyP95Ms !== null;
  const breaches =
    sources.budgetBreaches === undefined
      ? null
      : [...new Set(sources.budgetBreaches.filter((name) => BUDGETS.includes(name)))].sort();
  return {
    build_time_bucket: sources.buildMs === undefined ? null : bucketMs(sources.buildMs),
    store_size_bucket: sources.index === undefined ? null : bucketBytes(sources.index.sizeBytes),
    // The Metrics report merges the tools into one histogram, so the figures are reported under one key.
    query_latency: measured ? { all: { p50_ms: activity.latencyP50Ms, p95_ms: activity.latencyP95Ms } } : null,
    hook_latency: sources.hookP95Ms === undefined || !Number.isFinite(sources.hookP95Ms) || sources.hookP95Ms < 0 ? null : { p95_ms: Math.round(sources.hookP95Ms) },
    budget_breaches: breaches,
  };
}

function reliability(sources: DiagnosticsSources): TypeValues {
  let codes: Record<string, number> | null = null;
  if (sources.errorCodes !== undefined) {
    const kept = Object.entries(sources.errorCodes)
      .filter(([code, count]) => CODE.test(code) && isCount(count))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, LIST_MAX);
    codes = Object.fromEntries(kept);
  }
  // A crash signature is a hash of atlas's own stack frames; nothing captures one yet.
  return { error_codes: codes, crash_signature: null };
}

function ratings(sources: DiagnosticsSources): TypeValues {
  if (sources.ratings === undefined) return { rating: null };
  const kept = sources.ratings
    .filter((entry) => ABOUT.test(entry.about) && Object.hasOwn(RATING_SYMBOL, entry.value))
    .slice(0, LIST_MAX)
    .map((entry) => ({ about: entry.about, value: RATING_SYMBOL[entry.value] }));
  return { rating: kept };
}

function notes(sources: DiagnosticsSources): TypeValues {
  if (sources.note === undefined) return { note: null };
  const scrubbed = scrubNote(sources.note);
  return { note: scrubbed === '' ? null : scrubbed };
}

/** The symbol a rating value is shown as (↑ ↔ ↓). */
export const ratingSymbol = (value: RatingFact['value']): string => RATING_SYMBOL[value];

/** The values of one data type, keyed by field name. An unknown type id has no values. */
export function collectType(typeId: string, sources: DiagnosticsSources): TypeValues {
  switch (typeId) {
    case 'header':
      return { atlas_version: sources.atlasVersion, catalog_version: sources.catalogVersion };
    case 'platform':
      return platform(sources);
    case 'agent_setup':
      return agentSetup(sources);
    case 'languages':
      return languages(sources);
    case 'scale':
      return scale(sources);
    case 'performance':
      return performance(sources);
    case 'reliability':
      return reliability(sources);
    case 'agent_behavior':
      // Hooks do not exist yet, so there is nothing to count: the fields are null, never zero.
      return { gate_stats: null, atlas_vs_grep: null };
    case 'ratings':
      return ratings(sources);
    case 'notes':
      return notes(sources);
    default:
      return {};
  }
}
