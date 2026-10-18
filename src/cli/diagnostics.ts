/**
 * `gsd-atlas diagnostics` (SKL-03; docs/DIAGNOSTICS.md section 4): the user-facing side of user-controlled diagnostics.
 * Diagnostics are off by default; this command is the only way to turn a data type on, and the Host refuses the whole
 * request kind when it was started for an agent's MCP server. The CLI imports only the host-client seam (adapter rule): it
 * sends requests and prints what the Host answers.
 *
 * `enable` and `types` ask questions, so they need a terminal and write nothing without one. Everything printed that came
 * from the Host's answer is shown with control characters escaped. Nothing here sends a report anywhere: `preview` shows the
 * exact report, and `--save` keeps it on this machine.
 */
import { DIAGNOSTICS_KIND, PROTOCOL_VERSION, RATING_FEATURES, RATING_VALUES } from '../host-client/index.ts';
import type { Envelope, HostClient, Request } from '../host-client/index.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, exitCodeFor } from './exit.ts';
import { isControl, oneLine, printEnvelope, show } from './text.ts';
import type { Sinks } from './text.ts';

/** What `diagnostics` needs from the CLI's io. */
export interface DiagnosticsIo extends Sinks {
  readonly client: HostClient;
  /** True when standard input and the stream the person reads are a terminal. Absent means no terminal. */
  readonly isTTY?: boolean | undefined;
  /** Asks one question on the terminal and resolves to the line the person typed. */
  readonly prompt?: ((question: string) => Promise<string>) | undefined;
}

/** The sub-commands, in the order the usage line names them. */
export const DIAGNOSTICS_SUBCOMMANDS = ['enable', 'types', 'preview', 'disable', 'history'] as const;
type Sub = (typeof DIAGNOSTICS_SUBCOMMANDS)[number];

/** What the person typed, with paths already made absolute. */
export interface DiagnosticsInput {
  readonly sub: string | undefined;
  readonly rest: readonly string[];
  readonly repo?: string | undefined;
  readonly cwd?: string | undefined;
  readonly note?: string | undefined;
  readonly rating?: string | undefined;
  readonly feature?: string | undefined;
  readonly save?: boolean | undefined;
}

type State = 'approved' | 'denied' | 'ask';

/** One data type as the Host's `types` answer describes it, read defensively. */
interface TypeInfo {
  readonly id: string;
  readonly title: string;
  readonly state: State;
  readonly needsReview: boolean;
  readonly howItHelps: string;
  readonly cannotReveal: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
}

const isSub = (name: string | undefined): name is Sub => (DIAGNOSTICS_SUBCOMMANDS as readonly string[]).includes(name ?? '');

const requestOf = (args: Record<string, unknown>): Request => ({ protocol: PROTOCOL_VERSION, kind: DIAGNOSTICS_KIND, args });

const NEEDS_TERMINAL = (sub: string): string => `gsd-atlas: error diagnostics_needs_terminal: diagnostics ${sub} needs a terminal\n`;

const OPENING = [
  'gsd-atlas diagnostics are off by default. Nothing is collected beyond the local metrics `status` shows, and nothing is sent, unless you turn a data type on here.',
  '',
  'You will be shown each data type in turn: its fields with the real values from this machine, how it helps the project, and what it cannot reveal. Every type starts denied.',
  'You answer approve, deny, or ask each time. Your choices are saved in your user-level configuration folder (diagnostics.json); a repository can never set them.',
  '',
  'A report is something you build, read and send yourself. When sending arrives in a later version it will be a GitHub issue under your own account, and issues in a public repository are public and show your GitHub name. Nothing is sent without your approval, and this version never sends anything: `gsd-atlas diagnostics preview` shows the exact report.',
  '',
].join('\n');

/** Text from the Host's answer made safe for a terminal: control characters, C1 controls and line separators are escaped. */
function plain(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    out += code === 0x0a || !isControl(code) ? char : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

/** A field value as the person reads it: JSON, or `no data yet` for null. */
const valueText = (value: unknown): string => (value === null || value === undefined ? 'no data yet' : plain(JSON.stringify(value)));

const indent = (text: string, spaces: number): string =>
  plain(text)
    .split('\n')
    .map((line) => `${' '.repeat(spaces)}${line}`)
    .join('\n');

function readTypes(data: unknown): TypeInfo[] | null {
  const list = (data as { types?: unknown } | null)?.types;
  if (!Array.isArray(list)) return null;
  const out: TypeInfo[] = [];
  for (const raw of list) {
    const item = raw as Record<string, unknown> | null;
    if (typeof item !== 'object' || item === null) return null;
    const state = item['state'];
    if (typeof item['id'] !== 'string' || typeof item['title'] !== 'string' || (state !== 'approved' && state !== 'denied' && state !== 'ask')) return null;
    if (!Array.isArray(item['fields'])) return null;
    out.push({
      id: item['id'],
      title: item['title'],
      state,
      needsReview: item['needs_review'] === true,
      howItHelps: typeof item['how_it_helps'] === 'string' ? item['how_it_helps'] : '',
      cannotReveal: typeof item['cannot_reveal'] === 'string' ? item['cannot_reveal'] : '',
      fields: (item['fields'] as Array<Record<string, unknown>>).map((field) => ({ name: String(field['name']), value: field['value'] })),
    });
  }
  return out;
}

/** Send one request; a client that throws is the CLI's usual `internal_error` line and exit 2. */
async function ask(io: DiagnosticsIo, request: Request): Promise<Envelope | null> {
  try {
    return await io.client.handle(request);
  } catch (error) {
    io.stderr.write(`gsd-atlas: error internal_error: ${oneLine(error instanceof Error ? error.message : String(error))}\n`);
    return null;
  }
}

/** The notes the Host adds in words (`diagnostics_*` infos): printed on stderr, after the envelope. */
function printNotes(io: DiagnosticsIo, envelope: Envelope): void {
  for (const d of envelope.diagnostics) {
    if (d.severity === 'info' && d.code.startsWith('diagnostics_')) io.stderr.write(`gsd-atlas: ${oneLine(d.message)}\n`);
  }
}

/** Print an answer exactly as returned, with its reasons and notes; resolves to its exit code. */
function finish(io: DiagnosticsIo, reply: Envelope): number {
  printEnvelope(io, reply);
  printNotes(io, reply);
  return exitCodeFor(reply);
}

type Answer = State | 'keep' | 'unknown';

/** approve (a, y), deny (d, n), ask each time (e, k); an empty line is `keep` (the caller decides what keep means). */
function parseAnswer(raw: string): Answer {
  const answer = raw.trim().toLowerCase();
  if (answer === '') return 'keep';
  if (['a', 'approve', 'y', 'yes'].includes(answer)) return 'approved';
  if (['d', 'deny', 'n', 'no'].includes(answer)) return 'denied';
  if (['e', 'ask', 'each', 'k'].includes(answer)) return 'ask';
  return 'unknown';
}

function showType(io: DiagnosticsIo, type: TypeInfo, at: number, of: number): void {
  const lines = [
    '',
    `[${String(at)}/${String(of)}] ${plain(type.title)}  (currently: ${type.state})`,
    ...(type.needsReview ? ['  This data type changed since you approved it, so it is off until you review it again.'] : []),
    '  Fields, with the values from this machine:',
    ...type.fields.map((field) => `    ${plain(field.name).padEnd(26)} ${valueText(field.value)}`),
    '  How it helps:',
    indent(type.howItHelps, 4),
    '  It cannot reveal:',
    indent(type.cannotReveal, 4),
    '',
  ];
  io.stderr.write(`${lines.join('\n')}\n`);
}

/**
 * Walk through `types`, one question each, and resolve to the choices that CHANGED the type's state. `defaultKeeps`: an empty
 * answer keeps the current state (`types`); otherwise it denies (`enable`: every type starts denied). A prompt that fails
 * (the terminal closed) resolves to null: nothing is saved.
 */
async function walk(io: DiagnosticsIo, types: readonly TypeInfo[], defaultKeeps: boolean): Promise<Record<string, State> | null> {
  const prompt = io.prompt as (question: string) => Promise<string>;
  const chosen: Record<string, State> = {};
  for (const [index, type] of types.entries()) {
    showType(io, type, index + 1, types.length);
    const question = `Share "${plain(type.title)}" in reports? [a]pprove / [d]eny / ask [e]ach time (Enter = ${defaultKeeps ? `keep ${type.state}` : 'deny'}): `;
    let answer: Answer;
    try {
      answer = parseAnswer(await prompt(question));
    } catch {
      return null;
    }
    if (answer === 'unknown') {
      io.stderr.write(`gsd-atlas: that answer was not understood, so "${plain(type.title)}" is ${defaultKeeps ? `left as ${type.state}` : 'denied'}\n`);
      answer = 'keep';
    }
    const next: State = answer === 'keep' ? (defaultKeeps ? type.state : 'denied') : answer;
    chosen[type.id] = next;
  }
  return chosen;
}

function summarize(io: DiagnosticsIo, reply: Envelope): void {
  const status = reply.data as { enabled?: unknown; types?: Array<{ id?: unknown; state?: unknown }> } | null;
  if (!reply.ok || status === null || !Array.isArray(status.types)) return;
  const taken = status.types.filter((type) => type.state === 'approved' || type.state === 'ask').length;
  io.stderr.write(
    status.enabled === true
      ? `gsd-atlas: saved. ${String(taken)} data type${taken === 1 ? ' is' : 's are'} approved or set to ask each time. Nothing is sent by this version: see the exact report with "gsd-atlas diagnostics preview".\n`
      : 'gsd-atlas: saved. The report header is not approved, so no report can be built and diagnostics stay off.\n',
  );
}

/** Fetch the walkthrough data, run `walk`, and send the changes. `selection` carries --repo and --cwd. */
async function review(io: DiagnosticsIo, input: DiagnosticsInput, ids: readonly string[], defaultKeeps: boolean): Promise<number> {
  const selection = { ...(input.repo === undefined ? {} : { repo: input.repo }), ...(input.cwd === undefined ? {} : { cwd: input.cwd }) };
  const reply = await ask(io, requestOf({ action: 'types', ...(ids.length === 0 ? {} : { ids: [...ids] }), ...selection }));
  if (reply === null) return EXIT_FAILURE;
  if (!reply.ok) return finish(io, reply);
  const types = readTypes(reply.data);
  if (types === null) {
    io.stderr.write('gsd-atlas: error diagnostics_unreadable: the host answered with data types this command cannot read, so nothing was asked or written\n');
    return EXIT_FAILURE;
  }
  if (!defaultKeeps) io.stderr.write(OPENING);
  const chosen = await walk(io, types, defaultKeeps);
  if (chosen === null) {
    io.stderr.write('gsd-atlas: the terminal closed before the end, so nothing was changed\n');
    return EXIT_USAGE;
  }
  const changes = Object.fromEntries(Object.entries(chosen).filter(([id, state]) => types.find((type) => type.id === id)?.state !== state));
  if (defaultKeeps && Object.keys(changes).length === 0) {
    io.stderr.write('gsd-atlas: no changes\n');
    return EXIT_OK;
  }
  const done = await ask(io, requestOf({ action: 'set', choices: defaultKeeps ? changes : chosen }));
  if (done === null) return EXIT_FAILURE;
  const code = finish(io, done);
  if (code === EXIT_OK) summarize(io, done);
  return code;
}

async function preview(io: DiagnosticsIo, input: DiagnosticsInput): Promise<number> {
  const selection = { ...(input.repo === undefined ? {} : { repo: input.repo }), ...(input.cwd === undefined ? {} : { cwd: input.cwd }) };
  const given = {
    ...selection,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.rating === undefined ? {} : { rating: input.rating }),
    ...(input.rating === undefined || input.feature === undefined ? {} : { about: input.feature }),
  };
  const first = await ask(io, requestOf({ action: 'preview', ...given }));
  if (first === null) return EXIT_FAILURE;
  const data = first.data as { enabled?: unknown; ask_skipped?: Array<{ id?: unknown; title?: unknown }> } | null;
  if (!first.ok || data === null || data.enabled !== true) return finish(io, first);

  // Types set to "ask each time" are asked about now, on a terminal; without one they are left out and named.
  const skipped = (data.ask_skipped ?? []).filter((entry): entry is { id: string; title: string } => typeof entry.id === 'string' && typeof entry.title === 'string');
  const include: string[] = [];
  if (skipped.length > 0 && io.isTTY === true && io.prompt !== undefined) {
    for (const entry of skipped) {
      let answer = '';
      try {
        answer = await io.prompt(`Include "${plain(entry.title)}" in this report? [y/N] `);
      } catch {
        answer = '';
      }
      if (/^(y|yes)$/i.test(answer.trim())) include.push(entry.id);
    }
  } else if (skipped.length > 0) {
    io.stderr.write(`gsd-atlas: left out because they are set to ask each time (run on a terminal to be asked): ${skipped.map((entry) => plain(entry.title)).join(', ')}\n`);
  }

  const final = input.save === true || include.length > 0 ? await ask(io, requestOf({ action: input.save === true ? 'save' : 'preview', ...given, ...(include.length === 0 ? {} : { include }) })) : first;
  if (final === null) return EXIT_FAILURE;
  const code = finish(io, final);
  const out = final.data as { note_ignored?: unknown; rating_ignored?: unknown; path?: unknown } | null;
  if (out?.note_ignored === true) io.stderr.write('gsd-atlas: --note ignored: the notes data type is not approved (see "gsd-atlas diagnostics types notes")\n');
  if (out?.rating_ignored === true) io.stderr.write('gsd-atlas: --rating ignored: the ratings data type is not approved (see "gsd-atlas diagnostics types ratings")\n');
  if (final.ok && typeof out?.path === 'string') io.stderr.write(`gsd-atlas: saved the report to ${show(out.path)}; it stays on this machine\n`);
  return code;
}

async function disable(io: DiagnosticsIo, input: DiagnosticsInput): Promise<number> {
  const selection = { ...(input.repo === undefined ? {} : { repo: input.repo }), ...(input.cwd === undefined ? {} : { cwd: input.cwd }) };
  const reply = await ask(io, requestOf({ action: 'disable', ...selection }));
  if (reply === null) return EXIT_FAILURE;
  const code = finish(io, reply);
  if (!reply.ok) return code;
  const data = reply.data as { consent_reset?: unknown; removed_reports?: unknown; state_removed?: unknown; flight_cleared?: unknown; consent_file_invalid?: unknown } | null;
  const reports = typeof data?.removed_reports === 'number' ? data.removed_reports : 0;
  const removed = [
    ...(data?.consent_reset === true ? ['your saved consent choices were reset (every data type is denied)'] : []),
    ...(reports > 0 ? [`${String(reports)} saved report${reports === 1 ? '' : 's'}`] : []),
    ...(data?.state_removed === true ? ['the local diagnostics folder'] : []),
    ...(data?.flight_cleared === true ? ['the flight recorder of this repository'] : []),
  ];
  io.stderr.write(
    removed.length === 0 ? 'gsd-atlas: diagnostics are off; there was nothing to remove\n' : `gsd-atlas: diagnostics are off. Removed: ${removed.join(', ')}\n`,
  );
  if (data?.consent_file_invalid === true) {
    io.stderr.write('gsd-atlas: the consent file fails validation, so it was left alone; it is ignored and every data type is already off\n');
  }
  return code;
}

async function history(io: DiagnosticsIo): Promise<number> {
  const reply = await ask(io, requestOf({ action: 'history' }));
  if (reply === null) return EXIT_FAILURE;
  const code = finish(io, reply);
  if (!reply.ok) return code;
  const reports = (reply.data as { reports?: Array<{ file?: unknown; title?: unknown }> } | null)?.reports ?? [];
  if (reports.length === 0) io.stderr.write('gsd-atlas: no saved reports\n');
  for (const report of reports) {
    io.stderr.write(`  ${plain(String(report.file))}  ${plain(String(report.title))}\n`);
  }
  return code;
}

/** Run `gsd-atlas diagnostics <sub>`. Resolves to the process exit code; `usage` reports a usage error and returns its code. */
export async function runDiagnostics(io: DiagnosticsIo, input: DiagnosticsInput, usage: (message: string) => number): Promise<number> {
  if (!isSub(input.sub)) {
    return usage(`diagnostics needs one of: ${DIAGNOSTICS_SUBCOMMANDS.join('|')}`);
  }
  const sub = input.sub;
  // The flags of `preview` belong to it alone.
  if (sub !== 'preview') {
    const stray = (['note', 'rating', 'feature'] as const).find((flag) => input[flag] !== undefined) ?? (input.save === true ? 'save' : undefined);
    if (stray !== undefined) return usage(`--${stray} applies only to diagnostics preview`);
  }
  if (sub !== 'types' && input.rest.length > 0) return usage(`diagnostics ${sub} takes no arguments${sub === 'preview' ? ', only flags' : ''}`);

  if (sub === 'preview') {
    if (input.note !== undefined && input.note.trim() === '') return usage('--note needs some text');
    if (input.rating !== undefined && !(RATING_VALUES as readonly string[]).includes(input.rating)) return usage(`--rating must be one of ${RATING_VALUES.join(', ')}`);
    if (input.feature !== undefined) {
      if (input.rating === undefined) return usage('--feature names what a --rating is about, so it needs --rating');
      if (!([...RATING_FEATURES, 'last', 'session'] as readonly string[]).includes(input.feature)) {
        return usage(`--feature must be one of ${[...RATING_FEATURES, 'last', 'session'].join(', ')}`);
      }
    }
    return preview(io, input);
  }
  if (sub === 'enable' || sub === 'types') {
    // Checked before anything is sent: no terminal, no questions, and nothing is written.
    if (io.isTTY !== true || io.prompt === undefined) {
      io.stderr.write(NEEDS_TERMINAL(sub));
      return EXIT_FAILURE;
    }
    return review(io, input, input.rest, sub === 'types');
  }
  return sub === 'disable' ? disable(io, input) : history(io);
}
