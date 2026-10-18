/**
 * The worker protocol (plan 03-23): newline-delimited JSON, one message per line, validated with zod on both ends.
 *
 * Parent to worker: `init`, `resolve`, `relations`, `update`, `ping`. Worker to parent: `ready`, `edge`, `relation`, `done`,
 * `error`. A site is the
 * grammar tier's position (0-based row counted on LF only, UTF-16 column, BOM stripped); a target is a declaration's
 * name token as a repository-relative POSIX path plus its position and the compiler's name for the declaration's kind.
 *
 * Nothing the validators report quotes the input: a message names the field and the kind of problem only, because the
 * line came from a process that runs repository-influenced code and may carry file text.
 */
import { z } from 'zod';

/** The protocol number both ends must agree on. */
export const PROTOCOL_VERSION = 1;

/** Approved values of 03-CONSTANTS.md (`precise.*`). */
export const PRECISE_LIMITS = Object.freeze({
  /** `precise.maxLineBytes`: the longest single JSON line accepted from the worker. */
  maxLineBytes: 4_194_304,
  /** `precise.sitesPerRequest`: sites in one resolve message. */
  sitesPerRequest: 2000,
});

const MAX_PATH_CHARS = 4096;
const MAX_NAME_CHARS = 1024;

const row = z.int().min(0).max(2_147_483_647);

const Site = z.strictObject({
  path: z.string().min(1).max(MAX_PATH_CHARS),
  row,
  col: row,
  name: z.string().min(1).max(MAX_NAME_CHARS),
});

const Target = z.strictObject({
  path: z.string().min(1).max(MAX_PATH_CHARS),
  row,
  col: row,
  name: z.string().min(1).max(MAX_NAME_CHARS),
  kind: z.string().min(1).max(128),
});

const Id = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const RequestSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('init'),
    protocol: z.literal(PROTOCOL_VERSION),
    worktreeRoot: z.string().min(1).max(MAX_PATH_CHARS),
    /** The project's own compiler package directory (absolute), or null to use the bundled one. */
    compilerDir: z.string().min(1).max(MAX_PATH_CHARS).nullable(),
    bundledDir: z.string().min(1).max(MAX_PATH_CHARS),
    configs: z.array(z.string().min(1).max(MAX_PATH_CHARS)).max(200),
    heapMb: z.int().min(1).max(1_048_576),
    /** Plan 03-27: the RSS limit (megabytes) and period (milliseconds) of the worker's own sampler thread. Absent: no sampler. */
    rssLimitMb: z.int().min(1).max(1_048_576).optional(),
    sampleMs: z.int().min(1).max(3_600_000).optional(),
  }),
  z.strictObject({
    t: z.literal('resolve'),
    id: Id,
    config: z.string().min(1).max(MAX_PATH_CHARS),
    sites: z.array(Site).max(PRECISE_LIMITS.sitesPerRequest),
  }),
  /** Plan 03-25: the relations (extends, implements, overrides) of the classes and interfaces declared in `files`. */
  z.strictObject({
    t: z.literal('relations'),
    id: Id,
    config: z.string().min(1).max(MAX_PATH_CHARS),
    files: z.array(z.string().min(1).max(MAX_PATH_CHARS)).max(PRECISE_LIMITS.sitesPerRequest),
  }),
  /**
   * Plan 03-29 (TSM-06): the repository-relative paths whose content differs from what the worker last heard (`changed`; a path
   * that is new is in it too) and the paths that left the overlay (`removed`). The worker marks the programs those paths belong
   * to, and rebuilds each of them at its next use with the old program as the starting point, reading only the changed files. A
   * path that belongs to no program is ignored. At most `sitesPerRequest` paths in each list; a bigger change is several messages.
   */
  z.strictObject({
    t: z.literal('update'),
    id: Id,
    changed: z.array(z.string().min(1).max(MAX_PATH_CHARS)).max(PRECISE_LIMITS.sitesPerRequest),
    removed: z.array(z.string().min(1).max(MAX_PATH_CHARS)).max(PRECISE_LIMITS.sitesPerRequest),
  }),
  z.strictObject({ t: z.literal('ping'), id: Id }),
]);

/** The relation kinds the worker may report (the kernel's `RelationKind`). */
const RelationName = z.enum(['extends', 'implements', 'overrides']);

export const ResponseSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('ready'),
    compiler: z.strictObject({
      version: z.string().min(1).max(64),
      source: z.enum(['project', 'bundled']),
    }),
    rssMb: z.number().min(0).max(1_048_576),
    /** The worker's own process id, for observation only; the parent never signals a process by this number. */
    pid: z.int().min(1).max(4_294_967_295).optional(),
    /** Plan 03-27: true when the worker's RSS sampler thread is running (observation only). */
    sampler: z.boolean().optional(),
  }),
  z.strictObject({ t: z.literal('edge'), id: Id, site: Site, targets: z.array(Target).max(64) }),
  /** Plan 03-25: one relation between two declarations, both as the name token of the declaration plus its kind. */
  z.strictObject({ t: z.literal('relation'), id: Id, from: Target, to: Target, relation: RelationName }),
  z.strictObject({
    t: z.literal('done'),
    id: Id,
    asked: z.int().min(0),
    answered: z.int().min(0),
    /** Plan 03-27 (observation only): programs this worker holds after the request, and its resident memory in megabytes. */
    programs: z.int().min(0).max(100_000).optional(),
    rssMb: z.number().min(0).max(1_048_576).optional(),
    /** Plan 03-29 (observation only): source files the worker read from disk since its last report (a rebuild reads the changed ones). */
    reads: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  z.strictObject({
    t: z.literal('error'),
    id: Id.nullable(),
    code: z.string().min(1).max(64),
    message: z.string().max(512),
  }),
]);

export type Request = z.infer<typeof RequestSchema>;
export type Response = z.infer<typeof ResponseSchema>;
export type Site = z.infer<typeof Site>;
export type Target = z.infer<typeof Target>;

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** One problem per issue, naming the field and the kind of problem; the offending value is never copied. */
function describe(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const where = issue.path.length === 0 ? 'message' : issue.path.map(String).join('.');
    return `${where}: ${issue.code}`;
  });
  return `invalid message (${parts.join('; ')})`;
}

function parseLine<T>(schema: z.ZodType<T>, line: string, maxLineBytes: number): Parsed<T> {
  if (Buffer.byteLength(line, 'utf8') > maxLineBytes) return { ok: false, message: 'invalid message (line too long)' };
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, message: 'invalid message (not JSON)' };
  }
  const result = schema.safeParse(json);
  return result.success ? { ok: true, value: result.data } : { ok: false, message: describe(result.error) };
}

/** Validate one line the parent sent (worker side). */
export function parseRequest(line: string, maxLineBytes: number = PRECISE_LIMITS.maxLineBytes): Parsed<Request> {
  return parseLine(RequestSchema, line, maxLineBytes);
}

/** Validate one line the worker sent (parent side). */
export function parseResponse(line: string, maxLineBytes: number = PRECISE_LIMITS.maxLineBytes): Parsed<Response> {
  return parseLine(ResponseSchema, line, maxLineBytes);
}

/** One message as a line, validated first so a bug on this side can not send what the other side would refuse. */
export function encodeRequest(message: Request): string {
  return `${JSON.stringify(RequestSchema.parse(message))}\n`;
}

export function encodeResponse(message: Response): string {
  return `${JSON.stringify(ResponseSchema.parse(message))}\n`;
}
