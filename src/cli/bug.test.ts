/**
 * `gsd-atlas bug` (SKL-04, D-17): the CLI only sends requests and prints what the Host returns. The client is a recording
 * fake, the terminal state and the answers to the questions are injected, and the tests check what is sent, what is
 * shown to the person and what is printed. The privacy of the bundle itself is proved against the real Host in
 * src/host/bug.test.ts and scripts/bug-e2e.test.ts.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '../host-client/index.ts';
import type { Diagnostic, Envelope, HostClient, Request } from '../host-client/index.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from './index.ts';

const WORK = path.resolve('some', 'work');
const DIGEST = 'c'.repeat(64);
const SCHEMA = 'gsd-atlas.bug/1';
const DIR = path.join(path.sep, 'cache', 'gsd-atlas', 'bug-reports', '20261018T170000Z-cccccccc');
const PREVIEW = 'gsd-atlas bug bundle\n{ "format": "gsd-atlas-bug-v1" }\n';

const TYPES = [
  { id: 'problem', title: 'Problem statement', contains: 'feature and rating', helps: 'anchors the report', cannot_reveal: 'anything you did not write', names_and_paths: false },
  { id: 'versions', title: 'Versions and configuration', contains: 'versions', helps: 'matches your setup', cannot_reveal: 'paths or secrets', names_and_paths: false },
  { id: 'health', title: 'Store and host health', contains: 'counts and codes', helps: 'separates a sick store from a wrong answer', cannot_reveal: 'any fact', names_and_paths: false },
  { id: 'recorder', title: 'Flight recorder excerpt', contains: 'recent calls', helps: 'shows the sequence', cannot_reveal: 'names in hashed mode', names_and_paths: true },
  { id: 'failing', title: 'Failing answer', contains: 'the request and the envelope', helps: 'shows which tier answered', cannot_reveal: 'source text', names_and_paths: true },
];

const collected: Envelope = { schema: SCHEMA, ok: true, data: { preview: PREVIEW, digest: DIGEST, types: TYPES, included: [] }, diagnostics: [] };
const written: Envelope = { schema: SCHEMA, ok: true, data: { written: true, path: DIR, digest: DIGEST, preview: PREVIEW }, diagnostics: [] };
const failure = (code: string, message: string): Envelope => ({
  schema: 'gsd-atlas.error/1',
  ok: false,
  data: null,
  diagnostics: [{ code, severity: 'error', message } satisfies Diagnostic],
});

const ATTACH = 'Attach bundle.json to a new issue at https://github.com/open-gsd/gsd-atlas/issues/new; atlas does not upload anything.';

interface Options {
  readonly replies: readonly Envelope[];
  readonly isTTY: boolean;
  readonly answers?: readonly string[];
}

interface Harness {
  readonly requests: Request[];
  readonly stdout: string[];
  readonly stderr: string[];
  readonly asked: Array<{ readonly question: string; readonly stderrBefore: string }>;
  run(argv: readonly string[]): Promise<number>;
}

function harness(options: Options): Harness {
  const requests: Request[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const asked: Harness['asked'] = [];
  const replies = [...options.replies];
  const answers = [...(options.answers ?? [])];
  const client: HostClient = {
    handle(request: Request): Promise<Envelope> {
      requests.push(request);
      const next = replies.shift();
      return next === undefined ? Promise.reject(new Error('no scripted reply left')) : Promise.resolve(next);
    },
  };
  return {
    requests,
    stdout,
    stderr,
    asked,
    run: (argv) =>
      runCli(argv, {
        client,
        version: () => '9.9.9',
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
        cwd: WORK,
        isTTY: options.isTTY,
        prompt: (question) => {
          asked.push({ question, stderrBefore: stderr.join('') });
          return Promise.resolve(answers.shift() ?? '');
        },
      }),
  };
}

const plain = (replies: readonly Envelope[]): Harness => harness({ replies, isTTY: false });

describe('gsd-atlas bug without a terminal', () => {
  it('non-terminal needs text: with none of --what, --expected and --steps it sends nothing, prints a usage line and exits 2', async () => {
    const h = plain([]);
    const code = await h.run(['bug']);
    assert.equal(code, EXIT_FAILURE);
    assert.equal(h.requests.length, 0);
    assert.equal(h.stdout.length, 0);
    assert.match(h.stderr.join(''), /gsd-atlas bug needs at least one of --what, --expected or --steps/);
  });

  it('prints attach sentence: collects, writes with the digest, prints one envelope, then the directory and the sentence', async () => {
    const h = plain([collected, written]);
    const code = await h.run(['bug', '--what', 'refs missed a caller']);
    assert.equal(code, EXIT_OK);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[0], {
      protocol: PROTOCOL_VERSION,
      kind: 'bug',
      args: { action: 'collect', what: 'refs missed a caller', include: [], mode: 'hashed' },
    });
    assert.deepEqual(h.requests[1], {
      protocol: PROTOCOL_VERSION,
      kind: 'bug',
      args: { action: 'write', what: 'refs missed a caller', include: [], mode: 'hashed', confirm: DIGEST },
    });
    // One JSON envelope on stdout: the confirmed reply, which carries the preview.
    assert.equal(h.stdout.length, 1);
    assert.ok(h.stdout[0]?.endsWith('\n'));
    assert.deepEqual(JSON.parse(h.stdout[0] as string), written);
    const err = h.stderr.join('');
    assert.ok(err.includes(DIR), 'the directory is printed');
    assert.ok(err.includes(ATTACH), 'the fixed sentence is printed');
    assert.equal(h.asked.length, 0, 'no question without a terminal');
  });

  it('sends --include as a list, the selection flags as absolute paths, and the optional fields as they are', async () => {
    const h = plain([collected, written]);
    const code = await h.run([
      'bug',
      '--expected',
      'a caller',
      '--steps',
      'run find',
      '--include',
      'versions,recorder',
      '--feature',
      'code_refs',
      '--rating',
      'down',
      '--answer',
      'a_0123456789abcdef',
      '--repo',
      'repo',
      '--cwd',
      'sub',
    ]);
    assert.equal(code, EXIT_OK);
    assert.deepEqual((h.requests[0] as Request).args, {
      action: 'collect',
      repo: path.resolve(WORK, 'repo'),
      cwd: path.resolve(WORK, 'sub'),
      expected: 'a caller',
      steps: 'run find',
      feature: 'code_refs',
      rating: 'down',
      answer: 'a_0123456789abcdef',
      include: ['versions', 'recorder'],
      mode: 'hashed',
    });
  });

  it('confirm mismatch: an error on the write step prints the error envelope, no attach sentence and exits 2', async () => {
    const h = plain([collected, failure('confirm_mismatch', 'The confirmation does not match this bundle, so nothing was written.')]);
    const code = await h.run(['bug', '--what', 'x']);
    assert.equal(code, EXIT_FAILURE);
    assert.equal(h.stdout.length, 1);
    assert.equal((JSON.parse(h.stdout[0] as string) as Envelope).diagnostics[0]?.code, 'confirm_mismatch');
    assert.match(h.stderr.join(''), /confirm_mismatch/);
    assert.ok(!h.stderr.join('').includes(ATTACH));
  });

  it('second write refused: already_written is printed as an error and exits 2', async () => {
    const h = plain([collected, failure('already_written', 'This bundle was already written.')]);
    assert.equal(await h.run(['bug', '--what', 'x']), EXIT_FAILURE);
    assert.match(h.stderr.join(''), /already_written/);
    assert.ok(!h.stderr.join('').includes(ATTACH));
  });

  it('an error on the collect step stops there: nothing is written and the envelope is printed', async () => {
    const h = plain([failure('invalid_args', 'include: bad')]);
    assert.equal(await h.run(['bug', '--what', 'x']), EXIT_USAGE);
    assert.equal(h.requests.length, 1);
  });

  it('usage errors never reach the Host: an unknown mode, rating, feature or include, and a stray argument', async () => {
    for (const argv of [
      ['bug', '--what', 'x', '--mode', 'loud'],
      ['bug', '--what', 'x', '--rating', 'great'],
      ['bug', '--what', 'x', '--feature', 'nonsense'],
      ['bug', '--what', 'x', '--include', 'everything'],
      ['bug', '--what', 'x', '--answer', 'nope'],
      ['bug', 'stray', '--what', 'x'],
    ]) {
      const h = plain([]);
      assert.equal(await h.run(argv), EXIT_USAGE, JSON.stringify(argv));
      assert.equal(h.requests.length, 0, JSON.stringify(argv));
      assert.equal(h.stdout.length, 0);
    }
  });

  it('raw without confirm-raw: --mode raw with no confirmation and no terminal exits 2 in a fixed sentence and sends nothing', async () => {
    const h = plain([]);
    const code = await h.run(['bug', '--what', 'x', '--include', 'recorder', '--mode', 'raw']);
    assert.equal(code, EXIT_FAILURE);
    assert.equal(h.requests.length, 0);
    assert.equal(h.stdout.length, 0);
    assert.match(h.stderr.join(''), /raw_not_confirmed/);
    assert.match(h.stderr.join(''), /--confirm-raw/);
  });

  it('raw without confirm-raw: --mode raw with --confirm-raw proceeds, and both steps carry the confirmation', async () => {
    const h = plain([collected, written]);
    const code = await h.run(['bug', '--what', 'x', '--include', 'recorder', '--mode', 'raw', '--confirm-raw']);
    assert.equal(code, EXIT_OK);
    assert.deepEqual((h.requests[0] as Request).args, { action: 'collect', what: 'x', include: ['recorder'], mode: 'raw', confirm_raw: true });
    assert.deepEqual((h.requests[1] as Request).args, { action: 'write', what: 'x', include: ['recorder'], mode: 'raw', confirm_raw: true, confirm: DIGEST });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 3: the terminal flow, --clear and the no-network guard.
// ---------------------------------------------------------------------------------------------------------------------

const terminal = (replies: readonly Envelope[], answers: readonly string[]): Harness => harness({ replies, isTTY: true, answers });

describe('gsd-atlas bug at a terminal', () => {
  it('interactive approvals default deny: it asks the three questions, shows each type, and an empty or unclear answer is a no', async () => {
    const h = terminal([collected, { ...collected, data: { ...(collected.data as object), included: ['problem', 'recorder'] } }, written], [
      'refs missed a caller', // what happened
      'the callers of load', // expected
      'run find then refs', // steps
      'y', // problem
      '', // versions: empty is deny
      'n', // health
      'YES', // recorder
      'maybe', // failing: unclear is deny
      'y', // write this bundle
    ]);
    const code = await h.run(['bug']);
    assert.equal(code, EXIT_OK, h.stderr.join(''));

    assert.deepEqual(h.asked.map((entry) => entry.question), [
      'What happened? ',
      'What did you expect? ',
      'Steps to reproduce? ',
      'Include "Problem statement"? [y/N] ',
      'Include "Versions and configuration"? [y/N] ',
      'Include "Store and host health"? [y/N] ',
      'Include "Flight recorder excerpt"? [y/N] ',
      'Include "Failing answer"? [y/N] ',
      'Write this bundle on this machine? [y/N] ',
    ]);
    // Each type was described before it was asked about: what it contains, how it helps and what it cannot reveal.
    const before = h.asked[6]?.stderrBefore ?? '';
    for (const part of ['Flight recorder excerpt', 'recent calls', 'shows the sequence', 'names in hashed mode']) assert.ok(before.includes(part), part);
    // The first request only asks the Host what the types are (hashed, nothing approved); the second carries the approvals.
    assert.equal(h.requests.length, 3);
    assert.deepEqual((h.requests[0] as Request).args, {
      action: 'collect',
      what: 'refs missed a caller',
      expected: 'the callers of load',
      steps: 'run find then refs',
      include: [],
      mode: 'hashed',
    });
    assert.deepEqual((h.requests[1] as Request).args, {
      action: 'collect',
      what: 'refs missed a caller',
      expected: 'the callers of load',
      steps: 'run find then refs',
      include: ['problem', 'recorder'],
      mode: 'hashed',
    });
    assert.deepEqual((h.requests[2] as Request).args, { ...((h.requests[1] as Request).args as object), action: 'write', confirm: DIGEST });
    // The preview was shown before the final question, and the result is one envelope on stdout.
    assert.ok((h.asked[8]?.stderrBefore ?? '').includes(PREVIEW));
    assert.equal(h.stdout.length, 1);
    assert.ok(h.stderr.join('').includes(ATTACH));
  });

  it('interactive approvals default deny: nothing approved at all sends include as an empty list', async () => {
    const h = terminal([collected, collected, written], ['one', '', '', '', '', '', '', '', 'y']);
    assert.equal(await h.run(['bug']), EXIT_OK);
    assert.deepEqual((h.requests[1] as Request).args, { action: 'collect', what: 'one', include: [], mode: 'hashed' });
  });

  it('raw needs its own confirmation: a separate question names the consequence, and no is final', async () => {
    const h = terminal([], ['n']);
    const code = await h.run(['bug', '--what', 'x', '--include', 'recorder', '--mode', 'raw']);
    assert.equal(code, EXIT_USAGE);
    assert.equal(h.requests.length, 0, 'nothing was collected, let alone written');
    assert.equal(h.asked.length, 1);
    assert.match(h.asked[0]?.question ?? '', /RAW MODE/);
    assert.match(h.asked[0]?.question ?? '', /real symbol names and file paths/);
    assert.match(h.stderr.join(''), /nothing was written/);
  });

  it('raw needs its own confirmation: yes sends raw mode with the confirmation, and the write is still asked about', async () => {
    const h = terminal([collected, written], ['y', 'y']);
    const code = await h.run(['bug', '--what', 'x', '--include', 'recorder', '--mode', 'raw']);
    assert.equal(code, EXIT_OK, h.stderr.join(''));
    assert.deepEqual(h.asked.map((entry) => entry.question.slice(0, 8)), ['RAW MODE', 'Write th']);
    assert.deepEqual((h.requests[0] as Request).args, { action: 'collect', what: 'x', include: ['recorder'], mode: 'raw', confirm_raw: true });
  });

  it('raw needs its own confirmation: --confirm-raw at a terminal skips only that question', async () => {
    const h = terminal([collected, written], ['y']);
    assert.equal(await h.run(['bug', '--what', 'x', '--include', 'recorder', '--mode', 'raw', '--confirm-raw']), EXIT_OK);
    assert.deepEqual(h.asked.map((entry) => entry.question.slice(0, 8)), ['Write th']);
  });

  it('raw needs its own confirmation: the walkthrough request never carries raw mode', async () => {
    const h = terminal([collected, collected, written], ['one', '', '', '', '', '', 'y', 'y']);
    const code = await h.run(['bug', '--mode', 'raw', '--steps', 's', '--expected', 'e']);
    assert.equal(code, EXIT_OK, h.stderr.join(''));
    assert.equal((h.requests[0] as Request).args?.['mode' as never], 'hashed');
    assert.equal('confirm_raw' in ((h.requests[0] as Request).args as object), false);
    assert.equal((h.requests[1] as Request).args?.['mode' as never], 'raw');
    assert.equal((h.requests[1] as Request).args?.['confirm_raw' as never], true);
  });

  it('declined write: answering no to the final question writes nothing, prints no envelope and exits 1', async () => {
    const h = terminal([collected], ['n']);
    const code = await h.run(['bug', '--what', 'x', '--include', 'versions']);
    assert.equal(code, EXIT_USAGE);
    assert.equal(h.requests.length, 1, 'only the collect step was sent');
    assert.equal(h.stdout.length, 0);
    assert.match(h.stderr.join(''), /nothing was written/);
    assert.ok(!h.stderr.join('').includes(ATTACH));
  });

  it('declined write: an empty answer is a no too', async () => {
    const h = terminal([collected], ['']);
    assert.equal(await h.run(['bug', '--what', 'x', '--include', 'versions']), EXIT_USAGE);
    assert.equal(h.requests.length, 1);
  });

  it('with --include a terminal is not asked about types or text: only the write', async () => {
    const h = terminal([collected, written], ['y']);
    assert.equal(await h.run(['bug', '--include', 'recorder,failing']), EXIT_OK);
    assert.deepEqual(h.asked.map((entry) => entry.question.slice(0, 8)), ['Write th']);
    assert.deepEqual((h.requests[0] as Request).args, { action: 'collect', include: ['recorder', 'failing'], mode: 'hashed' });
  });

  it('a type description the CLI cannot read stops the walkthrough before anything is approved', async () => {
    const h = terminal([{ ...collected, data: { preview: PREVIEW, digest: DIGEST } }], ['x', '', '']);
    assert.equal(await h.run(['bug']), EXIT_FAILURE);
    assert.match(h.stderr.join(''), /bug_preview_unreadable/);
    assert.equal(h.requests.length, 1);
  });
});

describe('gsd-atlas bug --clear', () => {
  const cleared = (count: number): Envelope => ({ schema: SCHEMA, ok: true, data: { cleared: count }, diagnostics: [] });

  it('clear: empties the recorder of the repository, prints the envelope and says how many events went', async () => {
    const h = plain([cleared(12)]);
    const code = await h.run(['bug', '--clear', '--repo', 'repo']);
    assert.equal(code, EXIT_OK);
    assert.deepEqual(h.requests, [{ protocol: PROTOCOL_VERSION, kind: 'bug', args: { action: 'clear', repo: path.resolve(WORK, 'repo') } }]);
    assert.equal(h.stdout.length, 1);
    assert.deepEqual(JSON.parse(h.stdout[0] as string), cleared(12));
    assert.match(h.stderr.join(''), /removed 12 events from the flight recorder/);
  });

  it('clear: one event is singular, and none says it was already empty', async () => {
    const one = plain([cleared(1)]);
    await one.run(['bug', '--clear']);
    assert.match(one.stderr.join(''), /removed 1 event from the flight recorder/);
    const none = plain([cleared(0)]);
    await none.run(['bug', '--clear']);
    assert.match(none.stderr.join(''), /already empty/);
  });

  it('clear: it takes only the repository selection, so a report flag with it is a usage error and nothing is sent', async () => {
    for (const extra of [['--what', 'x'], ['--include', 'recorder'], ['--mode', 'raw'], ['--confirm-raw'], ['--rating', 'up']]) {
      const h = plain([]);
      assert.equal(await h.run(['bug', '--clear', ...extra]), EXIT_USAGE, JSON.stringify(extra));
      assert.equal(h.requests.length, 0);
    }
  });

  it('clear: a repository that is not one is the Host error, exit 2, with the envelope on stdout', async () => {
    const h = plain([failure('not_a_repo', 'repo must be an existing directory inside a git repository.')]);
    assert.equal(await h.run(['bug', '--clear']), EXIT_FAILURE);
    assert.equal(h.stdout.length, 1);
  });
});

describe('gsd-atlas bug opens no network connection', () => {
  it('no network: with fetch and the http and https request functions replaced by throwing stubs, every flow completes', async () => {
    const stubs = await stubTheNetwork();
    try {
      const flows: Array<() => Promise<number>> = [
        () => plain([collected, written]).run(['bug', '--what', 'x', '--include', 'versions,recorder']),
        () => terminal([collected, collected, written], ['a', '', '', 'y', 'y', 'y', 'y', 'y', 'y']).run(['bug']),
        () => terminal([collected, written], ['y', 'y']).run(['bug', '--what', 'x', '--include', 'versions', '--mode', 'raw']),
        () => plain([{ schema: SCHEMA, ok: true, data: { cleared: 2 }, diagnostics: [] }]).run(['bug', '--clear']),
      ];
      for (const flow of flows) assert.equal(await flow(), EXIT_OK);
      assert.equal(stubs.calls(), 0, 'nothing tried to open a connection');
    } finally {
      stubs.restore();
    }
  });
});

/** Replace every way a Node program opens a connection by a stub that records the attempt and throws. */
async function stubTheNetwork(): Promise<{ calls(): number; restore(): void }> {
  // The default export of a built-in is its mutable object; the module namespace itself is frozen.
  const { default: http } = await import('node:http');
  const { default: https } = await import('node:https');
  const { default: net } = await import('node:net');
  const { syncBuiltinESMExports } = await import('node:module');
  let attempts = 0;
  const refuse = (): never => {
    attempts += 1;
    throw new Error('network access in a test that must have none');
  };
  const saved: Array<() => void> = [];
  const replace = (target: object, key: string): void => {
    const holder = target as Record<string, unknown>;
    const original = holder[key];
    holder[key] = refuse;
    saved.push(() => {
      holder[key] = original;
    });
  };
  replace(globalThis, 'fetch');
  for (const key of ['request', 'get']) {
    replace(http, key);
    replace(https, key);
  }
  for (const key of ['connect', 'createConnection']) replace(net, key);
  syncBuiltinESMExports();
  return {
    calls: () => attempts,
    restore: () => {
      saved.forEach((undo) => undo());
      syncBuiltinESMExports();
    },
  };
}
