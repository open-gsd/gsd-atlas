/**
 * `gsd-atlas bug` (SKL-04, D-17): capture one defect into a LOCAL bundle the person reads before anything is written and
 * attaches to a GitHub issue themselves. This file only asks questions and sends requests; the Host gathers, hides and
 * writes (`src/host/bug.ts`). Nothing here, or anywhere in this command, opens a network connection.
 *
 * Three flows:
 *   - at a terminal with no `--include`: it asks what happened, what was expected and the steps, then shows each of the five
 *     data types with what it contains and what it cannot reveal and asks approve or deny (an empty answer is deny), shows the
 *     preview, and asks once more before writing. Declining writes nothing and exits 1;
 *   - without a terminal: a type is in the bundle only when `--include` names it, and at least one of `--what`, `--expected`
 *     or `--steps` is needed. `--mode raw` needs `--confirm-raw`;
 *   - `--clear`: empties the repository's flight recorder.
 * Names and paths are hashed unless `--mode redacted` or `--mode raw` says otherwise; raw is a separate, named confirmation.
 *
 * It imports only the host-client seam (adapter rule).
 */
import { ANSWER_ID_PATTERN, PROTOCOL_VERSION, RATING_FEATURES, RATING_VALUES } from '../host-client/index.ts';
import type { Envelope, HostClient, Request } from '../host-client/index.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, exitCodeFor } from './exit.ts';
import { oneLine, printEnvelope } from './text.ts';
import type { Sinks } from './text.ts';
import { BUG_INCLUDE, BUG_MODES } from './tool-commands.ts';

/** What `bug` needs from the CLI's io. */
export interface BugIo extends Sinks {
  readonly client: HostClient;
  /** True when standard input and the stream the person reads are a terminal. Absent means no terminal. */
  readonly isTTY?: boolean | undefined;
  /** Asks one question on the terminal and resolves to the line the person typed. */
  readonly prompt?: ((question: string) => Promise<string>) | undefined;
}

/** What the person typed, with paths already made absolute. */
export interface BugCliInput {
  readonly repo?: string | undefined;
  readonly cwd?: string | undefined;
  readonly what?: string | undefined;
  readonly expected?: string | undefined;
  readonly steps?: string | undefined;
  readonly feature?: string | undefined;
  readonly rating?: string | undefined;
  readonly answer?: string | undefined;
  /** The raw `--include` value: a comma-separated list. */
  readonly include?: string | undefined;
  readonly mode?: string | undefined;
  readonly confirmRaw: boolean;
  readonly clear: boolean;
}

/** The sentence that tells the person what to do with the bundle. Fixed. */
export const ATTACH_SENTENCE = 'Attach bundle.json to a new issue at https://github.com/open-gsd/gsd-atlas/issues/new; atlas does not upload anything.';

const NEEDS_TEXT =
  'gsd-atlas: error bug_needs_text: gsd-atlas bug needs at least one of --what, --expected or --steps when it has no terminal to ask on. Usage: gsd-atlas bug --what <text> [--expected <text>] [--steps <text>] [--include problem,versions,health,recorder,failing] [--mode hashed|redacted|raw] [--confirm-raw]\n';
const RAW_NEEDS_CONFIRM =
  'gsd-atlas: error raw_not_confirmed: --mode raw puts real symbol names and file paths into the bundle, so it needs --confirm-raw (or a terminal to confirm on). Nothing was written.\n';
const NOT_WRITTEN = 'gsd-atlas: nothing was written\n';
const RAW_QUESTION =
  'RAW MODE puts the real symbol names and file paths of your repository into the bundle, and anyone you share the bundle with can read them. Use raw mode? [y/N] ';
const WRITE_QUESTION = 'Write this bundle on this machine? [y/N] ';

const isYes = (answer: string): boolean => /^(y|yes)$/i.test(answer.trim());

/** One data type as the Host describes it for the walkthrough. */
interface TypeCard {
  readonly id: string;
  readonly title: string;
  readonly contains: string;
  readonly helps: string;
  readonly cannotReveal: string;
}

function readTypes(data: unknown): TypeCard[] | null {
  const list = (data as { types?: unknown } | null)?.types;
  if (!Array.isArray(list) || list.length === 0) return null;
  const cards: TypeCard[] = [];
  for (const each of list as unknown[]) {
    const entry = each as Record<string, unknown> | null;
    if (typeof entry !== 'object' || entry === null) return null;
    const { id, title, contains, helps, cannot_reveal: cannotReveal } = entry;
    if (typeof id !== 'string' || typeof title !== 'string' || typeof contains !== 'string' || typeof helps !== 'string' || typeof cannotReveal !== 'string') return null;
    cards.push({ id, title: oneLine(title), contains: oneLine(contains), helps: oneLine(helps), cannotReveal: oneLine(cannotReveal) });
  }
  return cards;
}

function readDigest(data: unknown): string | null {
  const digest = (data as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

const previewOf = (data: unknown): string | null => {
  const preview = (data as { preview?: unknown } | null)?.preview;
  return typeof preview === 'string' ? preview : null;
};

/** Send one request; a client that throws is the CLI's usual `internal_error` line and exit 2. */
async function ask(io: BugIo, args: Record<string, unknown>): Promise<Envelope | null> {
  const request: Request = { protocol: PROTOCOL_VERSION, kind: 'bug', args };
  try {
    return await io.client.handle(request);
  } catch (error) {
    io.stderr.write(`gsd-atlas: error internal_error: ${oneLine(error instanceof Error ? error.message : String(error))}\n`);
    return null;
  }
}

async function line(io: BugIo, question: string): Promise<string> {
  try {
    return (await (io.prompt as (question: string) => Promise<string>)(question)).trim();
  } catch {
    return '';
  }
}

/** The usage problem with the flags, or null when they are well formed. */
function problemWith(input: BugCliInput): string | null {
  if (input.mode !== undefined && !(BUG_MODES as readonly string[]).includes(input.mode)) return `--mode must be one of ${BUG_MODES.join(', ')}`;
  if (input.rating !== undefined && !(RATING_VALUES as readonly string[]).includes(input.rating)) return `--rating must be one of ${RATING_VALUES.join(', ')}`;
  if (input.feature !== undefined && !(RATING_FEATURES as readonly string[]).includes(input.feature)) {
    return `--feature must be one of ${RATING_FEATURES.join(', ')}`;
  }
  if (input.answer !== undefined && !ANSWER_ID_PATTERN.test(input.answer)) return '--answer must be the answer_id of an earlier answer';
  for (const type of includeList(input)) {
    if (!(BUG_INCLUDE as readonly string[]).includes(type)) return `--include names unknown data types; expected ${BUG_INCLUDE.join(', ')}`;
  }
  return null;
}

const includeList = (input: BugCliInput): string[] =>
  input.include === undefined
    ? []
    : input.include
        .split(',')
        .map((each) => each.trim())
        .filter((each) => each !== '');

/** `--clear`: empty the flight recorder of the repository, and say how many events went. */
async function clear(io: BugIo, input: BugCliInput): Promise<number> {
  const reply = await ask(io, { action: 'clear', ...(input.repo === undefined ? {} : { repo: input.repo }), ...(input.cwd === undefined ? {} : { cwd: input.cwd }) });
  if (reply === null) return EXIT_FAILURE;
  printEnvelope(io, reply);
  if (reply.ok) {
    const cleared = (reply.data as { cleared?: unknown } | null)?.cleared;
    io.stderr.write(
      typeof cleared === 'number' && cleared > 0
        ? `gsd-atlas: removed ${String(cleared)} event${cleared === 1 ? '' : 's'} from the flight recorder\n`
        : 'gsd-atlas: the flight recorder was already empty\n',
    );
  }
  return exitCodeFor(reply);
}

/** Run `gsd-atlas bug`. Resolves to the process exit code. */
export async function runBug(io: BugIo, input: BugCliInput, usage: (message: string) => number): Promise<number> {
  const problem = problemWith(input);
  if (problem !== null) return usage(problem);

  if (input.clear) {
    const others = [input.what, input.expected, input.steps, input.feature, input.rating, input.answer, input.include, input.mode].some((each) => each !== undefined);
    if (others || input.confirmRaw) return usage('--clear takes only --repo and --cwd');
    return clear(io, input);
  }

  const terminal = io.isTTY === true && io.prompt !== undefined;
  const interactive = terminal && input.include === undefined;
  const mode = input.mode ?? 'hashed';
  let confirmRaw = input.confirmRaw;

  // Checked before anything is sent: no terminal means no question, so every consent must already be on the command line.
  if (!terminal) {
    if (mode === 'raw' && !confirmRaw) {
      io.stderr.write(RAW_NEEDS_CONFIRM);
      return EXIT_FAILURE;
    }
    if (input.what === undefined && input.expected === undefined && input.steps === undefined) {
      io.stderr.write(NEEDS_TEXT);
      return EXIT_FAILURE;
    }
  }

  let { what, expected, steps } = input;
  let include = includeList(input);
  // `describing` is the walkthrough's own request, which only asks the Host what the data types are: it never carries raw mode.
  const sendArgs = (extra: Record<string, unknown>, describing = false): Record<string, unknown> => ({
    ...extra,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(what === undefined || what === '' ? {} : { what }),
    ...(expected === undefined || expected === '' ? {} : { expected }),
    ...(steps === undefined || steps === '' ? {} : { steps }),
    ...(input.feature === undefined ? {} : { feature: input.feature }),
    ...(input.rating === undefined ? {} : { rating: input.rating }),
    ...(input.answer === undefined ? {} : { answer: input.answer }),
    include,
    mode: describing ? 'hashed' : mode,
    ...(confirmRaw && !describing ? { confirm_raw: true } : {}),
  });

  if (interactive) {
    io.stderr.write('gsd-atlas: this makes a bundle on this machine for you to attach to a GitHub issue. Nothing is sent anywhere. Every data type below starts denied.\n');
    if (what === undefined) what = await line(io, 'What happened? ');
    if (expected === undefined) expected = await line(io, 'What did you expect? ');
    if (steps === undefined) steps = await line(io, 'Steps to reproduce? ');

    const described = await ask(io, sendArgs({ action: 'collect' }, true));
    if (described === null) return EXIT_FAILURE;
    const cards = described.ok ? readTypes(described.data) : null;
    if (!described.ok || cards === null) {
      printEnvelope(io, described);
      if (!described.ok) return exitCodeFor(described);
      io.stderr.write('gsd-atlas: error bug_preview_unreadable: the host answered with a description this command cannot read, so nothing was asked or written\n');
      return EXIT_FAILURE;
    }
    include = [];
    for (const card of cards) {
      io.stderr.write(
        [`${card.title}`, `  contains:       ${card.contains}`, `  how it helps:   ${card.helps}`, `  cannot reveal:  ${card.cannotReveal}`, ''].join('\n'),
      );
      if (isYes(await line(io, `Include "${card.title}"? [y/N] `))) include.push(card.id);
    }
  }

  // Raw is its own question, whatever else was approved: it names what it gives away.
  if (mode === 'raw' && !confirmRaw) {
    if (!isYes(await line(io, RAW_QUESTION))) {
      io.stderr.write(NOT_WRITTEN);
      return EXIT_USAGE;
    }
    confirmRaw = true;
  }

  const collected = await ask(io, sendArgs({ action: 'collect' }));
  if (collected === null) return EXIT_FAILURE;
  if (!collected.ok) {
    printEnvelope(io, collected);
    return exitCodeFor(collected);
  }
  const digest = readDigest(collected.data);
  const preview = previewOf(collected.data);
  if (digest === null || preview === null) {
    io.stderr.write('gsd-atlas: error bug_preview_unreadable: the host answered with a preview this command cannot read, so nothing was written\n');
    return EXIT_FAILURE;
  }

  if (terminal) {
    io.stderr.write(`${preview}\n`);
    if (!isYes(await line(io, WRITE_QUESTION))) {
      io.stderr.write(NOT_WRITTEN);
      return EXIT_USAGE;
    }
  }

  const done = await ask(io, sendArgs({ action: 'write', confirm: digest }));
  if (done === null) return EXIT_FAILURE;
  printEnvelope(io, done);
  if (!done.ok) return exitCodeFor(done);
  const where = (done.data as { path?: unknown } | null)?.path;
  io.stderr.write(`gsd-atlas: bundle written to ${typeof where === 'string' ? oneLine(where) : 'the cache directory'}\n${ATTACH_SENTENCE}\n`);
  return EXIT_OK;
}
