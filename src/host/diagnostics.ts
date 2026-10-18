/**
 * `diagnostics` (SKL-03; docs/DIAGNOSTICS.md; the draft user-controlled-diagnostics ADR): the Host's one request kind for
 * user-controlled diagnostics. The CLI only sends requests; the Host assembles the data sources and calls
 * `src/diagnostics`, which holds the catalog, the per-type consent and the report layout.
 *
 * What this kind never does: it never touches a network, never stores a token, and never reads a repository file. Consent is
 * read from, and written to, the USER's directory only, and a Host started for MCP refuses the kind itself (an agent can
 * neither enable, approve nor change diagnostics). This phase renders and saves reports locally; submission is Phase 4.
 */
import { z } from 'zod';
import { collectType, defaultCatalogDir, loadCatalog, loadConsent, renderReport } from '../diagnostics/index.ts';
import type {
  ActivityFacts,
  Catalog,
  Consent,
  DiagnosticsFs,
  DiagnosticsSources,
  IndexFacts,
  LoadedConsent,
  ModuleFacts,
  PlatformFacts,
} from '../diagnostics/index.ts';
import { diagnostic, okEnvelope } from '../facts/index.ts';
import type { Diagnostic, Envelope, Request } from '../facts/index.ts';
import { errorEnvelope } from '../query/index.ts';
import { RATING_FEATURES, RATING_VALUES } from '../tenant/index.ts';
import { firstProblem } from './route.ts';
import type { Selection } from './route.ts';

/** The request kind, and the one Governor key its requests run under. */
export const DIAGNOSTICS_KIND = 'diagnostics';

/** Envelope schema of a `diagnostics` reply. */
export const DIAGNOSTICS_SCHEMA = 'gsd-atlas.diagnostics/1';

/** What the Host knows about one repository, from its tenant: counts and codes only, never a name or a path. */
export interface RepoFacts {
  readonly worktrees: number | null;
  readonly index: IndexFacts | null;
  readonly activity: ActivityFacts | null;
  /** Outcome code to count, from the flight recorder; null when there is no recorder. */
  readonly errorCodes: Readonly<Record<string, number>> | null;
}

/** What the Host supplies: it alone knows the user's directory, the version and where the facts come from. */
export interface DiagnosticsDeps {
  /** The user-level configuration folder: `<userDir>/diagnostics.json` holds the choices. */
  readonly userDir: string;
  /** The version of this build; it is the report's `atlas_version`. */
  readonly version: string;
  /** The folder the shipped catalog is read from. */
  readonly catalogDir?: string | undefined;
  /** The file-system calls the module makes, so a test can record them. */
  readonly io?: DiagnosticsFs | undefined;
  readonly platform: PlatformFacts;
  readonly agentHost: string;
  readonly transport: string;
  /** The module registry as seen from the user's roots only (never a repository). */
  readonly modules: () => readonly ModuleFacts[];
  /** The facts of the repository a selection names, or null when it is not one or has no index. Opens no store of its own. */
  readonly repoFacts: (selection: Selection) => Promise<RepoFacts | null>;
}

const text = z.string().min(1);
const selection = { repo: text.optional(), cwd: text.optional() };
const typeId = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
/** What a rating can be about: a feature of the closed rating list, or the newest answer or the session. */
const ABOUT = z.enum([...RATING_FEATURES, 'last', 'session']);

const statusArgs = z.strictObject({ action: z.literal('status') });
const typesArgs = z.strictObject({ action: z.literal('types'), ids: z.array(typeId).max(32).optional(), ...selection });
const previewArgs = z.strictObject({
  action: z.literal('preview'),
  ...selection,
  note: z.string().max(10_000).optional(),
  rating: z.enum(RATING_VALUES).optional(),
  about: ABOUT.optional(),
  include: z.array(typeId).max(32).optional(),
});

const argsSchema = z.discriminatedUnion('action', [statusArgs, typesArgs, previewArgs]);

/** One data type as `status` lists it. */
export interface TypeStatus {
  readonly id: string;
  readonly title: string;
  readonly required: boolean;
  readonly state: 'approved' | 'denied' | 'ask';
  /** True when the user had approved an older field list: denied until they review it again. */
  readonly needs_review: boolean;
}

export interface StatusData {
  readonly enabled: boolean;
  readonly catalog_version: number;
  readonly saved: boolean;
  readonly types: readonly TypeStatus[];
  /** Types the catalog has and the user's saved choices do not mention. */
  readonly new_types: readonly string[];
}

/** One data type as the walkthrough shows it: its fields with the real values from this machine, and both explanations. */
export interface TypeView extends TypeStatus {
  readonly how_it_helps: string;
  readonly cannot_reveal: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly example: string; readonly kind: string; readonly value: unknown }>;
}

export interface TypesData {
  readonly catalog_version: number;
  readonly types: readonly TypeView[];
}

export interface PreviewData {
  readonly enabled: boolean;
  readonly title?: string;
  readonly labels?: readonly string[];
  readonly body?: string;
  readonly json?: Readonly<Record<string, unknown>>;
  /** Types set to "ask each time" that this report left out: ask the person and send them back in `include`. */
  readonly ask_skipped?: readonly string[];
  /** The note was given but the notes type is not taken for this report, so it was dropped. */
  readonly note_ignored?: true;
  /** The rating was given but the ratings type is not taken for this report, so it was dropped. */
  readonly rating_ignored?: true;
}

const OFF_TEXT = 'Diagnostics are off: nothing is collected and nothing is sent. Turn them on, one data type at a time, with "gsd-atlas diagnostics enable".';
const NO_HEADER_TEXT =
  'No report can be built: the report header is not approved. Review it with "gsd-atlas diagnostics types header".';

/** The macOS version a Darwin kernel major belongs to (Darwin 20 is macOS 11; from Darwin 25 the numbers are one apart again). */
function macOsMajor(darwin: number): number | null {
  if (darwin >= 25) return darwin + 1;
  if (darwin >= 20) return darwin - 9;
  return null;
}

/**
 * The platform facts of a Node process: the OS family and its major version, and the Node major. The version is the
 * marketing major (macOS 27, Windows 11), the Linux kernel major, or null when it cannot be told.
 */
export function platformFactsOf(platform: string, release: string, nodeVersion: string): PlatformFacts {
  const first = Number.parseInt(release.split('.')[0] ?? '', 10);
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0] ?? '', 10);
  const node = Number.isInteger(nodeMajor) && nodeMajor >= 0 ? nodeMajor : null;
  if (platform === 'darwin') return { osFamily: 'macOS', osMajor: Number.isInteger(first) ? macOsMajor(first) : null, nodeMajor: node };
  if (platform === 'win32') {
    const build = Number.parseInt(release.split('.')[2] ?? '', 10);
    return { osFamily: 'Windows', osMajor: Number.isInteger(build) ? (build >= 22_000 ? 11 : 10) : Number.isInteger(first) ? first : null, nodeMajor: node };
  }
  if (platform === 'linux') return { osFamily: 'Linux', osMajor: Number.isInteger(first) && first >= 0 ? first : null, nodeMajor: node };
  return { osFamily: 'other', osMajor: null, nodeMajor: node };
}

const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The index and activity facts out of the data of a `status` reply. Anything that is not the expected shape is left out:
 * a missing figure is `null`, never a guess.
 */
export function factsFromStatus(data: unknown): { readonly index: IndexFacts | null; readonly activity: ActivityFacts | null } {
  const report = (typeof data === 'object' && data !== null ? (data as { report?: unknown }).report : undefined) as
    | {
        answers?: { total?: unknown; latency?: { p50UpperBoundMs?: unknown; p95UpperBoundMs?: unknown } };
        degraded?: unknown;
        indexHealth?: { files?: unknown; errorFiles?: unknown; sizeBytes?: unknown } | null;
      }
    | undefined;
  if (report === undefined || report === null) return { index: null, activity: null };
  const health = report.indexHealth;
  const index =
    health !== null && health !== undefined && asNumber(health.files) !== null && asNumber(health.errorFiles) !== null && asNumber(health.sizeBytes) !== null
      ? { files: health.files as number, errorFiles: health.errorFiles as number, sizeBytes: health.sizeBytes as number }
      : null;
  const total = asNumber(report.answers?.total);
  const degraded =
    typeof report.degraded === 'object' && report.degraded !== null
      ? Object.values(report.degraded as Record<string, unknown>).reduce<number>((sum, count) => sum + (asNumber(count) ?? 0), 0)
      : 0;
  const activity =
    total === null
      ? null
      : {
          answersTotal: total,
          degradedTotal: degraded,
          latencyP50Ms: asNumber(report.answers?.latency?.p50UpperBoundMs),
          latencyP95Ms: asNumber(report.answers?.latency?.p95UpperBoundMs),
        };
  return { index, activity };
}

/** The types whose values come from a repository's index rather than from the machine. */
const REPO_TYPES: ReadonlySet<string> = new Set(['languages', 'scale', 'performance', 'reliability']);

/** A user-level note about the consent file: ignored whole when wrong, said once, in fixed words. */
const consentWarnings = (loaded: LoadedConsent): Diagnostic[] =>
  loaded.warning === undefined ? [] : [diagnostic('consent_ignored', 'warning', loaded.warning)];

/** A type reviewed again because the catalog changed it: named by id (a closed list), never by its saved content. */
const reviewNotes = (loaded: LoadedConsent): Diagnostic[] =>
  loaded.needsReview.length === 0
    ? []
    : [
        diagnostic(
          'diagnostics_needs_review',
          'info',
          `The catalog changed these data types since you approved them, so they are off until you review them again: ${loaded.needsReview.join(', ')}.`,
        ),
      ];

interface Context {
  readonly catalog: Catalog;
  readonly loaded: LoadedConsent;
}

const isTaken = (consent: Consent, id: string, include: readonly string[]): boolean => {
  const entry = consent.types[id];
  return entry !== undefined && (entry.state === 'approved' || (entry.state === 'ask' && include.includes(id)));
};

const headerOn = (consent: Consent): boolean => (consent.types['header']?.state ?? 'denied') !== 'denied';

const statusOf = (context: Context): StatusData => ({
  enabled: headerOn(context.loaded.consent),
  catalog_version: context.catalog.catalogVersion,
  saved: context.loaded.saved,
  types: context.catalog.types.map((type) => ({
    id: type.id,
    title: type.title,
    required: type.required === true,
    state: context.loaded.consent.types[type.id]?.state ?? 'denied',
    needs_review: context.loaded.needsReview.includes(type.id),
  })),
  new_types: context.loaded.newTypes,
});

/** The sources the collectors read, for the types in `ids`: the repository is looked at only when one of them needs it. */
async function gather(
  deps: DiagnosticsDeps,
  catalog: Catalog,
  ids: readonly string[],
  chosen: Selection,
  extra: Pick<DiagnosticsSources, 'note' | 'ratings'>,
): Promise<DiagnosticsSources> {
  const repo = ids.some((id) => REPO_TYPES.has(id)) ? await deps.repoFacts(chosen) : null;
  return {
    atlasVersion: deps.version,
    catalogVersion: catalog.catalogVersion,
    platform: deps.platform,
    agentHost: deps.agentHost,
    transport: deps.transport,
    modules: deps.modules(),
    ...(repo?.index == null ? {} : { index: repo.index }),
    ...(repo?.activity == null ? {} : { activity: repo.activity }),
    ...(repo?.worktrees == null ? {} : { worktreeCount: repo.worktrees }),
    ...(repo?.errorCodes == null ? {} : { errorCodes: repo.errorCodes }),
    ...extra,
  };
}

async function types(deps: DiagnosticsDeps, context: Context, ids: readonly string[] | undefined, chosen: Selection): Promise<Envelope> {
  const { catalog, loaded } = context;
  const wanted = ids === undefined || ids.length === 0 ? catalog.types.map((type) => type.id) : ids;
  const unknown = wanted.filter((id) => !catalog.types.some((type) => type.id === id));
  if (unknown.length > 0) return errorEnvelope('invalid_args', 'ids: no such data type');
  const sources = await gather(deps, catalog, wanted, chosen, {});
  const status = statusOf(context).types;
  const views: TypeView[] = catalog.types
    .filter((type) => wanted.includes(type.id))
    .map((type) => {
      const values = collectType(type.id, sources);
      return {
        ...(status.find((entry) => entry.id === type.id) as TypeStatus),
        how_it_helps: type.howItHelps,
        cannot_reveal: type.cannotReveal,
        fields: type.fields.map((field) => ({ name: field.name, example: field.example, kind: field.kind, value: values[field.name] ?? null })),
      };
    });
  return okEnvelope<TypesData>(DIAGNOSTICS_SCHEMA, { catalog_version: catalog.catalogVersion, types: views }, [...consentWarnings(loaded), ...reviewNotes(loaded)]);
}

async function preview(deps: DiagnosticsDeps, context: Context, args: z.infer<typeof previewArgs>): Promise<Envelope> {
  const { catalog, loaded } = context;
  const notes = [...consentWarnings(loaded), ...reviewNotes(loaded)];
  const header = loaded.consent.types['header'];
  if (header === undefined || header.state === 'denied') {
    const why = loaded.saved && Object.values(loaded.consent.types).some((entry) => entry.state !== 'denied') ? NO_HEADER_TEXT : OFF_TEXT;
    return okEnvelope<PreviewData>(DIAGNOSTICS_SCHEMA, { enabled: false }, [...notes, diagnostic('diagnostics_off', 'info', why)]);
  }
  const include = args.include ?? [];
  const taken = catalog.types.filter((type) => isTaken(loaded.consent, type.id, include)).map((type) => type.id);
  const notesTaken = taken.includes('notes');
  const ratingsTaken = taken.includes('ratings');
  const rating = args.rating === undefined ? undefined : { about: args.about ?? 'session', value: args.rating };
  const sources = await gather(deps, catalog, taken, { repo: args.repo, cwd: args.cwd }, {
    ...(notesTaken && args.note !== undefined ? { note: args.note } : {}),
    ...(ratingsTaken && rating !== undefined ? { ratings: [rating] } : {}),
  });
  const values: Record<string, Record<string, unknown>> = {};
  for (const id of taken) values[id] = { ...collectType(id, sources) };
  const report = renderReport({
    catalog,
    consent: loaded.consent,
    values,
    version: deps.version,
    include,
    ...(notesTaken && args.note !== undefined ? { note: args.note } : {}),
    ...(ratingsTaken && rating !== undefined ? { rating } : {}),
  });
  const askSkipped = catalog.types.filter((type) => loaded.consent.types[type.id]?.state === 'ask' && !include.includes(type.id)).map((type) => type.id);
  const data: PreviewData = {
    enabled: true,
    title: report.title,
    labels: report.labels,
    body: report.body,
    json: report.json,
    ask_skipped: askSkipped,
    ...(args.note !== undefined && !notesTaken ? { note_ignored: true as const } : {}),
    ...(rating !== undefined && !ratingsTaken ? { rating_ignored: true as const } : {}),
  };
  return okEnvelope<PreviewData>(DIAGNOSTICS_SCHEMA, data, notes);
}

/** Answer one `diagnostics` request. */
export async function handleDiagnostics(request: Request, deps: DiagnosticsDeps): Promise<Envelope> {
  const given = request.args === undefined || request.args === null ? {} : request.args;
  if (typeof given !== 'object' || Array.isArray(given)) return errorEnvelope('invalid_args', 'args must be an object');
  const parsed = argsSchema.safeParse(given);
  if (!parsed.success) return errorEnvelope('invalid_args', firstProblem(parsed.error));

  let catalog: Catalog;
  try {
    catalog = loadCatalog(deps.catalogDir ?? defaultCatalogDir(), undefined, deps.io);
  } catch {
    return errorEnvelope('catalog_unavailable', 'The diagnostics catalog that ships with this build could not be read.');
  }
  const context: Context = { catalog, loaded: loadConsent(deps.userDir, catalog, deps.io) };
  const args = parsed.data;
  switch (args.action) {
    case 'status':
      return okEnvelope<StatusData>(DIAGNOSTICS_SCHEMA, statusOf(context), [...consentWarnings(context.loaded), ...reviewNotes(context.loaded)]);
    case 'types':
      return types(deps, context, args.ids, { repo: args.repo, cwd: args.cwd });
    case 'preview':
      return preview(deps, context, args);
  }
}
