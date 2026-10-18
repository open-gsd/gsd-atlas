/**
 * `gsd-atlas rate up|meh|down [--session | --feature <name> | --last]` (plan 03-17, SKL-02, D-16): the command builds
 * one `rate` request, prints the Host's envelope unchanged and says on stderr what was recorded. Only the person at
 * the terminal rates; the MCP tool table has no rating tool.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION, RATING_FEATURES, TOOLS, TOOL_NAMES } from '../host-client/index.ts';
import type { Envelope, HostClient, Request } from '../host-client/index.ts';
import { runCli } from './index.ts';

interface Harness {
  readonly requests: Request[];
  readonly stdout: string[];
  readonly stderr: string[];
  run(argv: readonly string[]): Promise<number>;
}

const WORK = path.resolve('some', 'work');
const REPO = path.resolve('a', 'repository');
const SUB = path.join(REPO, 'src');

const recorded = (extra: Record<string, unknown>): Envelope => ({
  schema: 'gsd-atlas.rate/1',
  ok: true,
  data: { recorded: true, ...extra },
  diagnostics: [],
});

const failure = (code: string, message: string): Envelope => ({
  schema: 'gsd-atlas.error/1',
  ok: false,
  data: null,
  diagnostics: [{ code, severity: 'error', message }],
});

function harness(reply: Envelope): Harness {
  const requests: Request[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client: HostClient = {
    async handle(request: Request): Promise<Envelope> {
      requests.push(request);
      return reply;
    },
  };
  return {
    requests,
    stdout,
    stderr,
    run: (argv) =>
      runCli(argv, {
        client,
        version: () => '9.9.9',
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
        cwd: WORK,
      }),
  };
}

const rateRequest = (args: Record<string, unknown>): Request => ({ protocol: PROTOCOL_VERSION, kind: 'rate', args });

describe('rate last', () => {
  it('rate up is rate up --last: one request for the newest answer, the envelope printed unchanged, one line on stderr', async () => {
    const reply = recorded({ scope: 'answer', value: 'up', answer_id: 'a_0123456789abcdef' });
    for (const argv of [['rate', 'up'], ['rate', 'up', '--last']]) {
      const h = harness(reply);
      assert.equal(await h.run(argv), 0, JSON.stringify(argv));
      assert.deepEqual(h.requests, [rateRequest({ value: 'up', scope: 'answer' })]);
      assert.deepEqual(h.stdout.map((line) => JSON.parse(line)), [reply]);
      assert.equal(h.stderr.length, 1);
      assert.match(h.stderr[0] ?? '', /^gsd-atlas: [^\n]*\n$/);
      assert.doesNotMatch(h.stderr.join(''), /a_0123456789abcdef/, 'the confirmation does not repeat the answer id');
    }
  });

  it('meh and down are accepted, and the repository selection flags are resolved against the working directory', async () => {
    for (const value of ['meh', 'down']) {
      const h = harness(recorded({ scope: 'answer', value }));
      assert.equal(await h.run(['rate', value, '--repo', REPO, '--cwd', SUB]), 0);
      assert.deepEqual(h.requests, [rateRequest({ value, scope: 'answer', repo: REPO, cwd: SUB })]);
    }
    const relative = harness(recorded({ scope: 'answer', value: 'up' }));
    assert.equal(await relative.run(['rate', 'up', '--repo', 'sibling']), 0);
    assert.deepEqual(relative.requests[0]?.args, { value: 'up', scope: 'answer', repo: path.resolve(WORK, 'sibling') });
  });
});

describe('rate feature', () => {
  it('rate meh --feature code_refs sends a feature rating; skill, build and init are features too', async () => {
    const h = harness(recorded({ scope: 'feature', value: 'meh', feature: 'code_refs' }));
    assert.equal(await h.run(['rate', 'meh', '--feature', 'code_refs']), 0);
    assert.deepEqual(h.requests, [rateRequest({ value: 'meh', scope: 'feature', feature: 'code_refs' })]);
    for (const feature of ['skill', 'build', 'init']) {
      const each = harness(recorded({ scope: 'feature', value: 'up', feature }));
      assert.equal(await each.run(['rate', 'up', '--feature', feature]), 0, feature);
      assert.equal((each.requests[0]?.args as Record<string, unknown>)['feature'], feature);
    }
  });

  it('every tool name is a feature, and the list is the closed one the Host reads', () => {
    for (const name of TOOL_NAMES) assert.ok((RATING_FEATURES as readonly string[]).includes(name), name);
    assert.deepEqual([...RATING_FEATURES].slice(-3), ['skill', 'build', 'init']);
  });

  it('a feature outside the closed list, or an empty one, is a usage error that does not reach the host', async () => {
    for (const feature of ['nonsense', 'CODE_FIND', '', 'code_find ']) {
      const h = harness(recorded({}));
      assert.equal(await h.run(['rate', 'up', `--feature=${feature}`]), 1, JSON.stringify(feature));
      assert.deepEqual(h.requests, []);
      assert.deepEqual(h.stdout, []);
      assert.match(h.stderr.join(''), /^gsd-atlas: [^\n]*feature[^\n]*\nUsage: gsd-atlas/);
    }
  });
});

describe('rate session', () => {
  it('rate down --session sends a session rating', async () => {
    const h = harness(recorded({ scope: 'session', value: 'down', session_id: 's_0123456789abcdef' }));
    assert.equal(await h.run(['rate', 'down', '--session']), 0);
    assert.deepEqual(h.requests, [rateRequest({ value: 'down', scope: 'session' })]);
  });
});

describe('two scopes', () => {
  it('two scope flags together are a usage error, and nothing is sent', async () => {
    for (const argv of [
      ['rate', 'up', '--session', '--last'],
      ['rate', 'up', '--session', '--feature', 'code_find'],
      ['rate', 'up', '--last', '--feature', 'code_find'],
      ['rate', 'up', '--session', '--last', '--feature', 'code_find'],
    ]) {
      const h = harness(recorded({}));
      assert.equal(await h.run(argv), 1, JSON.stringify(argv));
      assert.deepEqual(h.requests, [], JSON.stringify(argv));
      assert.match(h.stderr.join(''), /^gsd-atlas: [^\n]*(--session|scope)[^\n]*\nUsage: gsd-atlas/);
    }
  });
});

describe('usage errors', () => {
  it('a missing, unknown or extra value is a usage error', async () => {
    for (const argv of [['rate'], ['rate', 'great'], ['rate', 'UP'], ['rate', 'up', 'down'], ['rate', '--last']]) {
      const h = harness(recorded({}));
      assert.equal(await h.run(argv), 1, JSON.stringify(argv));
      assert.deepEqual(h.requests, []);
    }
  });

  it('note flag refused: there is no --note, and the usage text does not offer one', async () => {
    for (const argv of [['rate', 'up', '--note', 'fine'], ['rate', 'up', '--note=fine'], ['rate', 'up', '--comment', 'x'], ['rate', 'up', '--text', 'x']]) {
      const h = harness(recorded({}));
      assert.equal(await h.run(argv), 1, JSON.stringify(argv));
      assert.deepEqual(h.requests, []);
      assert.match(h.stderr.join(''), /^gsd-atlas: [^\n]*\nUsage: gsd-atlas/);
    }
    const help = harness(recorded({}));
    await help.run(['--help']);
    const usage = help.stdout.join('');
    assert.match(usage, /gsd-atlas rate up\|meh\|down/);
    assert.doesNotMatch(usage, /--note/);
  });

  it('flags that belong to other commands do not apply to rate', async () => {
    for (const argv of [['rate', 'up', '--limit', '1'], ['rate', 'up', '--budget', '1'], ['rate', 'up', '--full'], ['find', 'x', '--session'], ['health', '--last'], ['build', '--feature', 'build']]) {
      const h = harness(recorded({}));
      assert.equal(await h.run(argv), 1, JSON.stringify(argv));
      assert.deepEqual(h.requests, []);
    }
  });
});

describe('no recent answer', () => {
  it('a Host that has no answer to rate gives an error envelope; it is printed unchanged and the confirmation line is not', async () => {
    const reply = failure('no_recent_answer', 'There is no recent answer to rate.');
    const h = harness(reply);
    assert.equal(await h.run(['rate', 'up']), 2, 'any failure that is not a usage error, a held lease or a busy host exits 2');
    assert.deepEqual(h.stdout.map((line) => JSON.parse(line)), [reply]);
    assert.equal(h.stderr.length, 1);
    assert.match(h.stderr[0] ?? '', /^gsd-atlas: error no_recent_answer: /);
  });

  it('a rating that could not be saved is a failure with its own code, never a crash', async () => {
    const reply = failure('rating_not_saved', 'The rating could not be saved.');
    const h = harness(reply);
    assert.equal(await h.run(['rate', 'meh', '--feature', 'code_find']), 2);
    assert.match(h.stderr.join(''), /rating_not_saved/);
    assert.doesNotMatch(h.stderr.join(''), /recorded/);
  });
});

describe('no agent can rate', () => {
  it('no tool is named rate or rating, and the CLI command is not a tool', () => {
    for (const name of TOOL_NAMES) assert.doesNotMatch(name, /^rat(e|ing)/, name);
    for (const tool of TOOLS) assert.doesNotMatch(tool.name, /rat(e|ing)/, tool.name);
  });
});
