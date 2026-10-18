/**
 * `gsd-atlas diagnostics` (SKL-03): the user-facing surface of the consent model, through the CLI and a real in-process Host
 * over a temporary user directory and a temporary state directory. Terminal state and the person's answers are injected.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import { PROTOCOL_VERSION, createInProcessHostClient } from '../host-client/index.ts';
import type { Envelope, HostClient, Request } from '../host-client/index.ts';
import { makeTempDir } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from './index.ts';

const VERSION = '1.2.3';
const WORK = path.resolve('some', 'work');
const PLATFORM = { osFamily: 'macOS', osMajor: 27, nodeMajor: 24 } as const;

interface Options {
  /** True: a terminal, answering from `answers`. */
  readonly tty?: boolean;
  readonly answers?: readonly string[];
  /** Give the Host a state directory (the composition root's job). Default true. */
  readonly state?: boolean;
  /** The repository root of the Host (a folder). Default: a path that does not exist. */
  readonly repoRoot?: string;
  /** A recording file-system for the diagnostics module. */
  readonly io?: typeof fs;
  /** Throw from the prompt, as a closed terminal does. */
  readonly promptThrows?: boolean;
}

interface Session {
  readonly tmp: TempDir;
  readonly userDir: string;
  readonly stateDir: string;
  readonly requests: Request[];
  readonly stdout: string[];
  readonly stderr: string[];
  /** What had been written to stderr when each question was asked, and the question. */
  readonly asked: Array<{ readonly question: string; readonly stderrBefore: string }>;
  run(argv: readonly string[]): Promise<number>;
  /** The one envelope printed to stdout by the last command. */
  envelope(): Envelope;
  consent(): { catalogVersion: number; types: Record<string, { state: string; fields: string[] }> };
}

/** A CLI over a real in-process Host whose user and state directories are temporary folders. */
function session(options: Options = {}): Session {
  const tmp = makeTempDir();
  const userDir = path.join(tmp.path, 'user');
  const stateDir = path.join(tmp.path, 'state');
  const real = createInProcessHostClient({
    roots: { repoRoot: options.repoRoot ?? WORK, userDir, builtinDir: null, npmRoots: [] },
    // Diagnostics need no grammar engine unless a tenant is opened, and none is here.
    engine: undefined as never,
    userDir,
    version: VERSION,
    ...(options.state === false ? {} : { stateDir }),
    diagnostics: { platform: PLATFORM, ...(options.io === undefined ? {} : { io: options.io }) },
  });
  const requests: Request[] = [];
  const client: HostClient = {
    handle(request: Request): Promise<Envelope> {
      requests.push(request);
      return real.handle(request);
    },
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const asked: Session['asked'] = [];
  const answers = [...(options.answers ?? [])];
  return {
    tmp,
    userDir,
    stateDir,
    requests,
    stdout,
    stderr,
    asked,
    run: (argv) =>
      runCli(argv, {
        client,
        version: () => VERSION,
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
        cwd: options.repoRoot ?? WORK,
        isTTY: options.tty === true,
        ...(options.tty === true
          ? {
              prompt: (question: string) => {
                asked.push({ question, stderrBefore: stderr.join('') });
                if (options.promptThrows === true) return Promise.reject(new Error('closed'));
                return Promise.resolve(answers.shift() ?? '');
              },
            }
          : {}),
      }),
    envelope: () => JSON.parse(stdout[stdout.length - 1] as string) as Envelope,
    consent: () => JSON.parse(fs.readFileSync(path.join(userDir, 'diagnostics.json'), 'utf8')) as ReturnType<Session['consent']>,
  };
}

const HEADER_ONLY = {
  catalogVersion: 1,
  types: { header: { state: 'approved', fields: ['atlas_version', 'catalog_version'] } },
};

const fields = (...names: string[]): string[] => names;
const WITH = {
  header: { state: 'approved', fields: fields('atlas_version', 'catalog_version') },
  platform: { state: 'approved', fields: fields('os_family', 'os_major', 'node_major') },
  ratings: { state: 'approved', fields: fields('rating') },
  notes: { state: 'approved', fields: fields('note') },
};

function writeConsent(s: Session, consent: unknown): void {
  fs.mkdirSync(s.userDir, { recursive: true });
  fs.writeFileSync(path.join(s.userDir, 'diagnostics.json'), JSON.stringify(consent));
}

/** The ten answers of a walkthrough, in catalog order. */
const TEN_DENY = Array.from({ length: 10 }, () => '');

describe('diagnostics preview', () => {
  it('header-only consent: prints one envelope whose data holds the title, labels and body', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    writeConsent(s, HEADER_ONLY);

    assert.equal(await s.run(['diagnostics', 'preview']), EXIT_OK, s.stderr.join(''));
    assert.equal(s.stdout.length, 1, 'one envelope on stdout');
    const envelope = s.envelope();
    assert.equal(envelope.ok, true);
    assert.equal(envelope.schema, 'gsd-atlas.diagnostics/1');
    const data = envelope.data as { enabled: boolean; title: string; labels: string[]; body: string; json: unknown };
    assert.equal(data.enabled, true);
    assert.equal(data.title, `[diagnostics] atlas ${VERSION}`);
    assert.deepEqual(data.labels, ['diagnostics']);
    assert.ok(data.body.includes('```diagnostics-v1\n'));
    assert.deepEqual(data.json, { catalog_version: 1, atlas_version: VERSION });
    assert.deepEqual(s.requests, [{ protocol: PROTOCOL_VERSION, kind: 'diagnostics', args: { action: 'preview' } }]);
  });

  it('two previews print the same bytes', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    writeConsent(s, HEADER_ONLY);
    await s.run(['diagnostics', 'preview']);
    await s.run(['diagnostics', 'preview']);
    assert.equal(s.stdout[0], s.stdout[1]);
  });

  it('no consent: says diagnostics are off and how to enable them, exit 0, data { enabled: false }', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'preview']), EXIT_OK, s.stderr.join(''));
    const envelope = s.envelope();
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data, { enabled: false });
    const said = s.stderr.join('');
    assert.match(said, /Diagnostics are off/);
    assert.match(said, /gsd-atlas diagnostics enable/);
  });

  it('nothing is written: no diagnostics.json, no folder, after a preview with no consent', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    await s.run(['diagnostics', 'preview']);
    assert.equal(fs.existsSync(s.userDir), false);
    assert.equal(fs.existsSync(s.stateDir), false);
  });

  it('after enabling the header only, diagnostics.json is the only file in the user directory', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    writeConsent(s, HEADER_ONLY);
    await s.run(['diagnostics', 'preview']);
    assert.deepEqual(fs.readdirSync(s.userDir), ['diagnostics.json']);
    assert.deepEqual(fs.readdirSync(s.tmp.path), ['user'], 'nothing else was created anywhere beside it');
  });
});

describe('preview with note and rating', () => {
  it('sends the note, the rating and the feature, and prints the scrubbed note and the rating in the report', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    writeConsent(s, { catalogVersion: 1, types: WITH });
    const code = await s.run(['diagnostics', 'preview', '--note', 'slow, see /home/me/x.ts', '--rating', 'meh', '--feature', 'code_context']);
    assert.equal(code, EXIT_OK, s.stderr.join(''));
    assert.deepEqual(s.requests[0]?.args, { action: 'preview', note: 'slow, see /home/me/x.ts', rating: 'meh', about: 'code_context' });
    const data = s.envelope().data as { title: string; labels: string[]; json: Record<string, unknown> };
    assert.equal(data.title, `[diagnostics] atlas ${VERSION} · macOS 27 · ↔ code_context`);
    assert.deepEqual(data.labels, ['diagnostics', 'rating:side', 'os:macos']);
    assert.equal(data.json['note'], 'slow, see [removed]');
    assert.deepEqual(data.json['rating'], [{ about: 'code_context', value: '↔' }]);
    assert.ok(!s.stderr.join('').includes('ignored'));
  });

  it('a note while the notes type is not approved is ignored, with a line on stderr, and not in the report', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    writeConsent(s, HEADER_ONLY);
    assert.equal(await s.run(['diagnostics', 'preview', '--note', 'private words', '--rating', 'up']), EXIT_OK);
    const said = s.stderr.join('');
    assert.match(said, /--note ignored/);
    assert.match(said, /--rating ignored/);
    assert.ok(!JSON.stringify(s.envelope()).includes('private words'));
  });

  it('a bad rating, a feature without a rating and an empty note are usage errors; nothing is sent', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'preview', '--rating', 'great']), EXIT_USAGE);
    assert.equal(await s.run(['diagnostics', 'preview', '--feature', 'code_find']), EXIT_USAGE);
    assert.equal(await s.run(['diagnostics', 'preview', '--rating', 'up', '--feature', '/etc/passwd']), EXIT_USAGE);
    assert.equal(await s.run(['diagnostics', 'preview', '--note', '']), EXIT_USAGE);
    assert.equal(s.requests.length, 0);
  });

  it('flags of other sub-commands do not apply: --note is for preview only', async (t) => {
    const s = session({ tty: true });
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'enable', '--note', 'x']), EXIT_USAGE);
    assert.equal(await s.run(['diagnostics', 'history', '--save']), EXIT_USAGE);
    assert.equal(await s.run(['find', 'x', '--note', 'x']), EXIT_USAGE, 'and not for other commands');
    assert.equal(s.requests.length, 0);
  });

  it('a type set to ask each time is asked about on a terminal and included only on yes; without a terminal it is left out and named', async (t) => {
    const s = session({ tty: true, answers: ['y'] });
    t.after(() => s.tmp.cleanup());
    writeConsent(s, { catalogVersion: 1, types: { ...WITH, platform: { state: 'ask', fields: WITH.platform.fields } } });
    assert.equal(await s.run(['diagnostics', 'preview']), EXIT_OK, s.stderr.join(''));
    assert.equal(s.asked.length, 1);
    assert.match(s.asked[0]?.question ?? '', /Platform/);
    assert.deepEqual(s.requests.map((request) => (request.args as { include?: string[] }).include), [undefined, ['platform']]);
    assert.equal(s.stdout.length, 1, 'only the final report is printed');
    assert.equal((s.envelope().data as { json: Record<string, unknown> }).json['os_family'], 'macOS');

    const no = session({ tty: true, answers: ['n'] });
    t.after(() => no.tmp.cleanup());
    writeConsent(no, { catalogVersion: 1, types: { ...WITH, platform: { state: 'ask', fields: WITH.platform.fields } } });
    await no.run(['diagnostics', 'preview']);
    assert.ok(!('os_family' in ((no.envelope().data as { json: Record<string, unknown> }).json)));

    const quiet = session();
    t.after(() => quiet.tmp.cleanup());
    writeConsent(quiet, { catalogVersion: 1, types: { ...WITH, platform: { state: 'ask', fields: WITH.platform.fields } } });
    await quiet.run(['diagnostics', 'preview']);
    assert.match(quiet.stderr.join(''), /ask each time[^\n]*Platform|Platform[^\n]*ask each time/i);
    assert.ok(!('os_family' in ((quiet.envelope().data as { json: Record<string, unknown> }).json)));
  });
});

describe('enable walkthrough', () => {
  it('explains first, then shows every type with its values and both explanations before asking; saves the choices', async (t) => {
    const answers = ['a', 'approve', 'e', '', 'd', 'yes', 'n', 'a', 'ask', 'no'];
    const s = session({ tty: true, answers });
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'enable']), EXIT_OK, s.stderr.join(''));

    // The opening explanation comes before the first question.
    const first = s.asked[0]?.stderrBefore ?? '';
    assert.match(first, /off by default/i);
    assert.match(first, /public/i);
    assert.match(first, /GitHub/);
    assert.match(first, /nothing is sent/i);
    assert.match(first, /Every type starts denied/i);
    assert.match(s.asked[0]?.question ?? '', /Report header/, 'the header is asked first');
    assert.equal(s.asked.length, 10, 'one question per type');

    // The person sees fields, real values, both texts, then the question.
    const platformBefore = s.asked[1]?.stderrBefore ?? '';
    for (const part of ['Platform', 'os_family', '"macOS"', 'os_major', '27', 'node_major', 'How it helps', 'file watchers', 'cannot reveal', 'machine name']) {
      assert.ok(platformBefore.includes(part), `the Platform block shows ${part}`);
    }
    const behaviourBefore = s.asked[7]?.stderrBefore ?? '';
    assert.match(behaviourBefore, /gate_stats[^\n]*no data yet/);

    // Choices are saved: approve, ask each time, deny.
    const consent = s.consent();
    const states = Object.fromEntries(Object.entries(consent.types).map(([id, entry]) => [id, entry.state]));
    assert.deepEqual(states, {
      header: 'approved',
      platform: 'approved',
      agent_setup: 'ask',
      languages: 'denied',
      scale: 'denied',
      performance: 'approved',
      reliability: 'denied',
      agent_behavior: 'approved',
      ratings: 'ask',
      notes: 'denied',
    });
    assert.deepEqual(consent.types['platform']?.fields, ['os_family', 'os_major', 'node_major']);

    // Requests: the values for the walkthrough, then one `set`; one envelope on stdout (the status after the set).
    assert.deepEqual(s.requests.map((request) => (request.args as { action: string }).action), ['types', 'set']);
    assert.equal(s.stdout.length, 1);
    assert.equal((s.envelope().data as { enabled: boolean }).enabled, true);
  });

  it('default deny: an empty answer denies, and so does an answer nobody recognises (with a note)', async (t) => {
    const s = session({ tty: true, answers: [...TEN_DENY.slice(0, 9), 'maybe'] });
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'enable']), EXIT_OK, s.stderr.join(''));
    assert.ok(Object.values(s.consent().types).every((entry) => entry.state === 'denied' && entry.fields.length === 0));
    assert.match(s.stderr.join(''), /not understood[^\n]*denied/i);
    assert.equal((s.envelope().data as { enabled: boolean }).enabled, false);
  });

  it('enable needs a terminal: no terminal, or no prompt, writes and sends nothing and exits 2', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'enable']), EXIT_FAILURE);
    assert.match(s.stderr.join(''), /diagnostics enable needs a terminal/);
    assert.equal(s.requests.length, 0);
    assert.equal(fs.existsSync(s.userDir), false);
    assert.equal(s.stdout.length, 0);
  });

  it('a prompt that fails (the terminal closed) saves nothing', async (t) => {
    const s = session({ tty: true, promptThrows: true });
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'enable']), EXIT_USAGE);
    assert.match(s.stderr.join(''), /nothing was changed/);
    assert.equal(fs.existsSync(s.userDir), false);
    assert.deepEqual(s.requests.map((request) => (request.args as { action: string }).action), ['types']);
  });

  it('enable takes no arguments', async (t) => {
    const s = session({ tty: true });
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'enable', 'header']), EXIT_USAGE);
    assert.equal(s.requests.length, 0);
  });

  it('text from the answer is printed with control characters escaped', async (t) => {
    const hostile: Envelope = {
      schema: 'gsd-atlas.diagnostics/1',
      ok: true,
      data: {
        catalog_version: 1,
        types: [
          {
            id: 'header',
            title: 'Header\u001b[2J',
            required: true,
            state: 'denied',
            needs_review: false,
            how_it_helps: 'helps\u001b[31m',
            cannot_reveal: 'nothing',
            fields: [{ name: 'atlas_version', example: '1', kind: 'string', value: 'v\u001b]0;x\u0007' }],
          },
        ],
      },
      diagnostics: [],
    };
    const stderr: string[] = [];
    const stdout: string[] = [];
    const client: HostClient = { handle: (request) => Promise.resolve((request.args as { action: string }).action === 'types' ? hostile : { schema: 'x', ok: true, data: { enabled: false }, diagnostics: [] }) };
    const code = await runCli(['diagnostics', 'enable'], {
      client,
      version: () => VERSION,
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
      cwd: WORK,
      isTTY: true,
      prompt: () => Promise.resolve(''),
    });
    assert.equal(code, EXIT_OK);
    const text = stderr.join('');
    assert.ok(!text.includes('\u001b'), 'no raw ESC reaches the terminal');
    assert.ok(!text.includes('\u0007'));
  });
});

describe('types', () => {
  it('asks again for the types named; an empty answer keeps the current choice; only changes are sent', async (t) => {
    const s = session({ tty: true, answers: ['', 'd'] });
    t.after(() => s.tmp.cleanup());
    writeConsent(s, { catalogVersion: 1, types: WITH });
    assert.equal(await s.run(['diagnostics', 'types', 'platform', 'notes']), EXIT_OK, s.stderr.join(''));
    assert.equal(s.asked.length, 2);
    assert.match(s.asked[0]?.stderrBefore ?? '', /currently: approved/);
    assert.deepEqual(s.requests.map((request) => request.args), [{ action: 'types', ids: ['platform', 'notes'] }, { action: 'set', choices: { notes: 'denied' } }]);
    const consent = s.consent();
    assert.equal(consent.types['platform']?.state, 'approved');
    assert.equal(consent.types['notes']?.state, 'denied');
    assert.equal(consent.types['header']?.state, 'approved', 'a type that was not named is untouched');
  });

  it('with no names it goes through every type; with no change it sends no set and says so', async (t) => {
    const s = session({ tty: true, answers: TEN_DENY });
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'types']), EXIT_OK, s.stderr.join(''));
    assert.equal(s.asked.length, 10);
    assert.deepEqual(s.requests.map((request) => (request.args as { action: string }).action), ['types']);
    assert.match(s.stderr.join(''), /no changes/i);
    assert.equal(fs.existsSync(s.userDir), false, 'nothing was written');
  });

  it('a type that needs review is shown as such and is asked again', async (t) => {
    const s = session({ tty: true, answers: ['a'] });
    t.after(() => s.tmp.cleanup());
    writeConsent(s, { catalogVersion: 1, types: { header: WITH.header, platform: { state: 'approved', fields: ['os_family'] } } });
    assert.equal(await s.run(['diagnostics', 'types', 'platform']), EXIT_OK, s.stderr.join(''));
    assert.match(s.asked[0]?.stderrBefore ?? '', /changed since you approved it/);
    assert.deepEqual(s.consent().types['platform']?.fields, ['os_family', 'os_major', 'node_major']);
  });

  it('an unknown type is a usage error from the Host; types needs a terminal', async (t) => {
    const s = session({ tty: true });
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'types', 'nope']), EXIT_USAGE);
    const quiet = session();
    t.after(() => quiet.tmp.cleanup());
    assert.equal(await quiet.run(['diagnostics', 'types', 'platform']), EXIT_FAILURE);
    assert.match(quiet.stderr.join(''), /diagnostics types needs a terminal/);
    assert.equal(quiet.requests.length, 0);
  });
});

describe('save', () => {
  it('preview --save writes the report on this machine, prints it and its path, and mode is 0600', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    writeConsent(s, { catalogVersion: 1, types: { header: WITH.header, platform: WITH.platform } });
    assert.equal(await s.run(['diagnostics', 'preview', '--save']), EXIT_OK, s.stderr.join(''));
    // The preview comes first, so nothing is written before the person has been asked about "ask each time" types.
    assert.deepEqual(s.requests.map((request) => (request.args as { action: string }).action), ['preview', 'save']);
    assert.equal(s.stdout.length, 1, 'only the saved report is printed');
    const data = s.envelope().data as { path: string; title: string; body: string };
    assert.equal(path.dirname(data.path), path.join(s.stateDir, 'diagnostics', 'reports'));
    assert.ok(fs.readFileSync(data.path, 'utf8').startsWith(`Title: ${data.title}\n`));
    assert.match(s.stderr.join(''), /saved the report/);
    assert.ok(s.stderr.join('').includes(JSON.stringify(data.path)), 'the path is printed, quoted');
    if (process.platform !== 'win32') assert.equal(fs.statSync(data.path).mode & 0o777, 0o600);
  });

  it('with diagnostics off, --save saves nothing', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'preview', '--save']), EXIT_OK);
    assert.equal(fs.existsSync(s.stateDir), false);
  });

  it('with no state directory the Host says so and the command fails', async (t) => {
    const s = session({ state: false });
    t.after(() => s.tmp.cleanup());
    writeConsent(s, HEADER_ONLY);
    assert.equal(await s.run(['diagnostics', 'preview', '--save']), EXIT_FAILURE);
    assert.match(s.stderr.join(''), /state_dir_unavailable/);
  });
});

describe('history', () => {
  it('lists the saved reports with their titles, newest first, and says when there are none', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'history']), EXIT_OK);
    assert.match(s.stderr.join(''), /no saved reports/i);
    writeConsent(s, { catalogVersion: 1, types: { header: WITH.header, platform: WITH.platform } });
    await s.run(['diagnostics', 'preview', '--save']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await s.run(['diagnostics', 'preview', '--save']);
    s.stderr.length = 0;
    s.stdout.length = 0;
    assert.equal(await s.run(['diagnostics', 'history']), EXIT_OK);
    const reports = (s.envelope().data as { reports: Array<{ file: string; title: string }> }).reports;
    assert.equal(reports.length, 2);
    const lines = s.stderr.join('').split('\n').filter((line) => line.includes('[diagnostics] atlas'));
    assert.equal(lines.length, 2);
    assert.ok(lines[0]?.includes(reports[0]?.file ?? '?'));
    assert.deepEqual(s.requests.at(-1)?.args, { action: 'history' });
  });
});

describe('disable removes local data', () => {
  it('everything is denied, saved reports and the state folder are gone, and the person is told what was removed', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    writeConsent(s, { catalogVersion: 1, types: { header: WITH.header, platform: WITH.platform } });
    await s.run(['diagnostics', 'preview', '--save']);
    await s.run(['diagnostics', 'preview', '--save']);
    s.stderr.length = 0;
    assert.equal(await s.run(['diagnostics', 'disable']), EXIT_OK, s.stderr.join(''));
    const said = s.stderr.join('');
    assert.match(said, /diagnostics are off/i);
    assert.match(said, /2 saved reports/);
    assert.match(said, /consent/i);
    assert.equal(fs.existsSync(path.join(s.stateDir, 'diagnostics')), false);
    assert.ok(Object.values(s.consent().types).every((entry) => entry.state === 'denied'));
    await s.run(['diagnostics', 'preview']);
    assert.deepEqual(s.envelope().data, { enabled: false });
  });

  it('with nothing to remove it says so and creates nothing', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'disable']), EXIT_OK);
    assert.match(s.stderr.join(''), /nothing to remove/i);
    assert.equal(fs.existsSync(s.userDir), false);
    assert.equal(fs.existsSync(s.stateDir), false);
  });

  it('a consent file that fails validation is left alone and the person is told', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    fs.mkdirSync(s.userDir, { recursive: true });
    fs.writeFileSync(path.join(s.userDir, 'diagnostics.json'), '{ nope');
    assert.equal(await s.run(['diagnostics', 'disable']), EXIT_OK);
    assert.match(s.stderr.join(''), /fails validation|invalid/i);
    assert.equal(fs.readFileSync(path.join(s.userDir, 'diagnostics.json'), 'utf8'), '{ nope');
  });

  it('takes no arguments', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'disable', 'now']), EXIT_USAGE);
    assert.equal(s.requests.length, 0);
  });
});

describe('fresh install writes nothing', () => {
  it('find, build, status, health and diagnostics preview through the CLI create no diagnostics file and no state folder', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    for (const argv of [['find', 'x'], ['build'], ['status'], ['health'], ['diagnostics', 'preview'], ['diagnostics', 'history'], ['lang', 'list']]) {
      await s.run(argv);
    }
    assert.equal(fs.existsSync(s.userDir), false, 'no user directory');
    assert.equal(fs.existsSync(s.stateDir), false, 'no state directory');
    assert.deepEqual(fs.readdirSync(s.tmp.path), [], 'nothing at all was created');
  });
});

describe('committed config has no effect', () => {
  it('a repository whose committed config names diagnostics and autoSubmit: preview still says off, and no file of the repository is opened', async (t) => {
    const touched: string[] = [];
    const wrapped: Record<string, unknown> = {};
    for (const name of ['mkdirSync', 'openSync', 'readSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync', 'realpathSync', 'readdirSync', 'rmSync', 'statSync'] as const) {
      const real = fs[name] as (...args: unknown[]) => unknown;
      wrapped[name] = (...args: unknown[]): unknown => {
        for (const argument of args.slice(0, 2)) if (typeof argument === 'string') touched.push(argument);
        return real(...args);
      };
    }
    const repo = makeTempDir();
    t.after(() => repo.cleanup());
    fs.mkdirSync(path.join(repo.path, '.gsd-atlas'));
    const hostile = JSON.stringify({ diagnostics: { enabled: true }, autoSubmit: true, permissions: { allow: [{ executable: 'node' }] } });
    fs.writeFileSync(path.join(repo.path, '.gsd-atlas', 'config.json'), hostile);
    fs.writeFileSync(path.join(repo.path, 'diagnostics.json'), JSON.stringify(HEADER_ONLY));
    const s = session({ repoRoot: repo.path, io: wrapped as unknown as typeof fs });
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'preview']), EXIT_OK, s.stderr.join(''));
    assert.deepEqual(s.envelope().data, { enabled: false });
    assert.match(s.stderr.join(''), /Diagnostics are off/);
    assert.ok(touched.length > 0, 'the recording is live');
    const real = fs.realpathSync.native(repo.path);
    for (const each of touched) {
      const resolved = path.resolve(each);
      const inside = (root: string): boolean => resolved === root || resolved.startsWith(root + path.sep);
      assert.ok(!inside(repo.path) && !inside(real), `opened ${each}, which is inside the repository`);
    }
    assert.equal(fs.existsSync(s.userDir), false);
  });
});

describe('no network', () => {
  it('every sub-command runs with fetch, http, https and net replaced by throwing stubs, and none is called', async (t) => {
    const calls: string[] = [];
    const boom = (name: string) => (): never => {
      calls.push(name);
      throw new Error(`network call: ${name}`);
    };
    const savedFetch = globalThis.fetch;
    globalThis.fetch = boom('fetch') as unknown as typeof fetch;
    t.after(() => {
      globalThis.fetch = savedFetch;
    });
    mock.method(http, 'request', boom('http.request'));
    mock.method(http, 'get', boom('http.get'));
    mock.method(https, 'request', boom('https.request'));
    mock.method(https, 'get', boom('https.get'));
    mock.method(net, 'connect', boom('net.connect'));
    mock.method(net, 'createConnection', boom('net.createConnection'));
    t.after(() => {
      mock.restoreAll();
    });

    const s = session({ tty: true, answers: ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', '', '', '', '', '', '', '', '', '', '', 'y', 'y'] });
    t.after(() => s.tmp.cleanup());
    const codes = [
      await s.run(['diagnostics', 'enable']),
      await s.run(['diagnostics', 'types', 'notes']),
      await s.run(['diagnostics', 'preview', '--note', 'hello', '--rating', 'up']),
      await s.run(['diagnostics', 'preview', '--save']),
      await s.run(['diagnostics', 'history']),
      await s.run(['diagnostics', 'disable']),
    ];
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0], s.stderr.join(''));
    assert.deepEqual(calls, [], 'nothing reached for the network');
  });
});

describe('diagnostics usage', () => {
  it('a missing or unknown sub-command is a usage error', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics']), EXIT_USAGE);
    assert.match(s.stderr.join(''), /enable\|types\|preview\|disable\|history/);
    assert.equal(await s.run(['diagnostics', 'frobnicate']), EXIT_USAGE);
    assert.equal(await s.run(['diagnostics', 'submit']), EXIT_USAGE, 'there is no submit in this version');
    assert.equal(s.requests.length, 0, 'nothing was sent');
  });

  it('preview takes no positional arguments; history takes none either', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'preview', 'extra']), EXIT_USAGE);
    assert.equal(await s.run(['diagnostics', 'history', 'extra']), EXIT_USAGE);
    assert.equal(s.requests.length, 0);
  });

  it('the usage text names the sub-commands and says nothing is sent', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    await s.run(['--help']);
    const usage = s.stdout.join('');
    assert.match(usage, /gsd-atlas diagnostics enable\|types\|preview\|disable\|history/);
    assert.match(usage, /Nothing is ever sent by this version/);
  });
});
