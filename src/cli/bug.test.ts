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
});
