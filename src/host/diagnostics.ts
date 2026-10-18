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
import type { Catalog, Consent, DiagnosticsFs, DiagnosticsSources, LoadedConsent } from '../diagnostics/index.ts';
import { diagnostic, okEnvelope } from '../facts/index.ts';
import type { Diagnostic, Envelope, Request } from '../facts/index.ts';
import { errorEnvelope } from '../query/index.ts';
import { firstProblem } from './route.ts';
import type { Selection } from './route.ts';

/** The request kind, and the one Governor key its requests run under. */
export const DIAGNOSTICS_KIND = 'diagnostics';

/** Envelope schema of a `diagnostics` reply. */
export const DIAGNOSTICS_SCHEMA = 'gsd-atlas.diagnostics/1';

/** What the Host supplies: it alone knows the user's directory, the version and where the facts come from. */
export interface DiagnosticsDeps {
  /** The user-level configuration folder: `<userDir>/diagnostics.json` holds the choices. */
  readonly userDir: string;
  /** The version of this build; it is the report's `atlas_version`. */
  readonly version: string;
  /** The folder the shipped catalog is read from. */
  readonly catalogDir?: string | undefined;
  /** The data the collectors read, for the repository the selection names (or none). */
  readonly gather: (selection: Selection) => Promise<DiagnosticsSources>;
  /** The file-system calls the module makes, so a test can record them. */
  readonly io?: DiagnosticsFs | undefined;
}

const text = z.string().min(1);
const selection = { repo: text.optional(), cwd: text.optional() };

const statusArgs = z.strictObject({ action: z.literal('status') });
const previewArgs = z.strictObject({ action: z.literal('preview'), ...selection });

const argsSchema = z.discriminatedUnion('action', [statusArgs, previewArgs]);

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

export interface PreviewData {
  readonly enabled: boolean;
  readonly title?: string;
  readonly labels?: readonly string[];
  readonly body?: string;
  readonly json?: Readonly<Record<string, unknown>>;
}

const OFF_TEXT = 'Diagnostics are off: nothing is collected and nothing is sent. Turn them on, one data type at a time, with "gsd-atlas diagnostics enable".';
const NO_HEADER_TEXT =
  'No report can be built: the report header is not approved. Review it with "gsd-atlas diagnostics types header".';

/** The user's choices are ignored whole when their file is wrong; say so once, in fixed words. */
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

function open(deps: DiagnosticsDeps, catalog: Catalog): Context {
  return { catalog, loaded: loadConsent(deps.userDir, catalog, deps.io) };
}

const isEnabled = (consent: Consent): boolean => {
  const header = consent.types['header'];
  return header !== undefined && header.state !== 'denied';
};

function statusOf(context: Context): StatusData {
  const { catalog, loaded } = context;
  return {
    enabled: isEnabled(loaded.consent),
    catalog_version: catalog.catalogVersion,
    saved: loaded.saved,
    types: catalog.types.map((type) => ({
      id: type.id,
      title: type.title,
      required: type.required === true,
      state: loaded.consent.types[type.id]?.state ?? 'denied',
      needs_review: loaded.needsReview.includes(type.id),
    })),
    new_types: loaded.newTypes,
  };
}

async function preview(deps: DiagnosticsDeps, context: Context, chosen: Selection): Promise<Envelope> {
  const { catalog, loaded } = context;
  const notes = [...consentWarnings(loaded), ...reviewNotes(loaded)];
  const header = loaded.consent.types['header'];
  if (header === undefined || header.state === 'denied') {
    const why = loaded.saved && Object.values(loaded.consent.types).some((entry) => entry.state !== 'denied') ? NO_HEADER_TEXT : OFF_TEXT;
    return okEnvelope<PreviewData>(DIAGNOSTICS_SCHEMA, { enabled: false }, [...notes, diagnostic('diagnostics_off', 'info', why)]);
  }
  const sources = await deps.gather(chosen);
  const values: Record<string, Record<string, unknown>> = {};
  for (const type of catalog.types) {
    const entry = loaded.consent.types[type.id];
    if (entry !== undefined && entry.state === 'approved') values[type.id] = { ...collectType(type.id, sources) };
  }
  const report = renderReport({ catalog, consent: loaded.consent, values, version: deps.version });
  return okEnvelope<PreviewData>(DIAGNOSTICS_SCHEMA, { enabled: true, title: report.title, labels: report.labels, body: report.body, json: report.json }, notes);
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
  const context = open(deps, catalog);
  const args = parsed.data;
  if (args.action === 'status') {
    return okEnvelope<StatusData>(DIAGNOSTICS_SCHEMA, statusOf(context), [...consentWarnings(context.loaded), ...reviewNotes(context.loaded)]);
  }
  return preview(deps, context, { repo: args.repo, cwd: args.cwd });
}
