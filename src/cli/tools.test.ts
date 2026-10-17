import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION, TOOLS, buildRequest } from '../host-client/index.ts';
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

const okReply = (schema: string): Envelope => ({ schema, ok: true, data: {}, diagnostics: [] });

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

/** The flags every code tool shares, and the request fields they map to. */
const SHARED_ARGV = ['--repo', REPO, '--cwd', SUB, '--budget', '800', '--more', 'cur', '--fresh', 'a.ts', '--fresh', 'b.ts', '--limit', '4'];
const SHARED_INPUT = { repo: REPO, cwd: SUB, budget_tokens: 800, more: 'cur', fresh: ['a.ts', 'b.ts'], limit: 4 };

describe('refs, context and impact: request equality with buildRequest', () => {
  it('refs request equals buildRequest(code_refs) with --path and --kind mapped to the schema fields', async () => {
    const h = harness(okReply('gsd-atlas.code-refs/1'));
    assert.equal(await h.run(['refs', 'load', ...SHARED_ARGV, '--path', 'a.ts', '--kind', 'function']), 0);
    assert.deepEqual(h.requests, [buildRequest('code_refs', { name: 'load', path: 'a.ts', kind: 'function', ...SHARED_INPUT })]);
    assert.equal(h.requests[0]?.budget_tokens, 800);
    assert.deepEqual(h.requests[0]?.fresh, ['a.ts', 'b.ts']);
    assert.equal(h.requests[0]?.worktree, REPO);
    assert.equal(h.stdout.length, 1);
    assert.deepEqual(h.stderr, []);
  });

  it('context request equals buildRequest(code_context) with --path mapped', async () => {
    const h = harness(okReply('gsd-atlas.code-context/1'));
    assert.equal(await h.run(['context', 'load', ...SHARED_ARGV, '--path', 'a.ts']), 0);
    assert.deepEqual(h.requests, [buildRequest('code_context', { name: 'load', path: 'a.ts', ...SHARED_INPUT })]);
  });

  it('impact request equals buildRequest(code_impact) with --depth, including a depth of zero', async () => {
    const h = harness(okReply('gsd-atlas.code-impact/1'));
    assert.equal(await h.run(['impact', 'load', ...SHARED_ARGV, '--path', 'a.ts', '--depth', '3']), 0);
    assert.deepEqual(h.requests, [buildRequest('code_impact', { name: 'load', path: 'a.ts', depth: 3, ...SHARED_INPUT })]);
    const zero = harness(okReply('gsd-atlas.code-impact/1'));
    assert.equal(await zero.run(['impact', 'load', '--depth', '0']), 0);
    assert.deepEqual(zero.requests, [buildRequest('code_impact', { name: 'load', depth: 0 })]);
  });

  it('health request equals buildRequest(atlas_status) and carries only the repo and the directory', async () => {
    const h = harness(okReply('gsd-atlas.atlas-status/1'));
    assert.equal(await h.run(['health', '--repo', REPO, '--cwd', SUB]), 0);
    assert.deepEqual(h.requests, [buildRequest('atlas_status', { repo: REPO, cwd: SUB })]);
    assert.deepEqual(h.requests[0]?.args, { repo: REPO, cwd: SUB });
    const bare = harness(okReply('gsd-atlas.atlas-status/1'));
    assert.equal(await bare.run(['health']), 0);
    assert.deepEqual(bare.requests, [buildRequest('atlas_status', {})]);
  });

  it('every tool command has a tool definition in TOOLS, so the schema it validates against is the MCP one', () => {
    const names = TOOLS.map((tool) => tool.name);
    for (const name of ['code_find', 'code_refs', 'code_context', 'code_impact', 'atlas_status']) {
      assert.ok(names.includes(name as (typeof names)[number]), name);
    }
  });
});

describe('unknown flag: every command rejects a flag it does not use', () => {
  it('exits 1 without contacting the host, with the usage text on stderr', async () => {
    const cases: string[][] = [
      ['find', 'x', '--depth', '2'],
      ['find', 'x', '--path', 'a.ts'],
      ['refs', 'x', '--mode', 'fuzzy'],
      ['refs', 'x', '--depth', '1'],
      ['context', 'x', '--kind', 'function'],
      ['context', 'x', '--mode', 'exact'],
      ['impact', 'x', '--kind', 'function'],
      ['impact', 'x', '--mode', 'exact'],
      ['health', '--limit', '1'],
      ['health', '--budget', '1'],
      ['build', '--budget', '1'],
      ['build', '--fresh', 'a.ts'],
      ['maintain', '--limit', '1'],
      ['maintain', '--since', '7d'],
      ['status', '--full'],
      ['status', '--repo-root', '/x'],
      ['status', '--agent', 'claude'],
      ['init', '--repo', 'x'],
      ['lang', 'list', '--repo', 'x'],
      ['lang', 'test', 'toy', '--full'],
      ['find', 'x', '--no-such-flag'],
    ];
    for (const argv of cases) {
      const h = harness(okReply('gsd-atlas.x/1'));
      assert.equal(await h.run(argv), 1, `argv ${JSON.stringify(argv)}`);
      assert.deepEqual(h.requests, [], `argv ${JSON.stringify(argv)} must not reach the host`);
      assert.deepEqual(h.stdout, []);
      assert.match(h.stderr.join(''), /^gsd-atlas: [^\n]*\nUsage: gsd-atlas/);
    }
  });

  it('a missing name, an extra name, a bad number and a schema violation exit 1 for refs, context and impact', async () => {
    for (const command of ['refs', 'context', 'impact']) {
      for (const argv of [[command], [command, 'a', 'b'], [command, 'x', '--limit', 'many'], [command, 'x', '--budget', '0'], [command, 'x', '--limit', '-1']]) {
        const h = harness(okReply('gsd-atlas.x/1'));
        assert.equal(await h.run(argv), 1, `argv ${JSON.stringify(argv)}`);
        assert.deepEqual(h.requests, []);
      }
    }
    const depth = harness(okReply('gsd-atlas.code-impact/1'));
    assert.equal(await depth.run(['impact', 'x', '--depth', 'deep']), 1);
    assert.equal(await depth.run(['impact', 'x', '--depth', '-1']), 1);
    assert.deepEqual(depth.requests, []);
  });
});

describe('maintain', () => {
  const maintainReply = okReply('gsd-atlas.maintain/1');

  it('maintain with no positional sends task all', async () => {
    const h = harness(maintainReply);
    assert.equal(await h.run(['maintain', '--repo', REPO]), 0);
    assert.deepEqual(h.requests, [{ protocol: PROTOCOL_VERSION, kind: 'maintain', args: { repo: REPO, task: 'all' } }]);
  });

  it('maintain sends the task it is given: reconcile, resolve, refresh, collect, compact, check and all', async () => {
    for (const task of ['reconcile', 'resolve', 'refresh', 'collect', 'compact', 'check', 'all']) {
      const h = harness(maintainReply);
      assert.equal(await h.run(['maintain', task]), 0, task);
      assert.deepEqual(h.requests, [{ protocol: PROTOCOL_VERSION, kind: 'maintain', args: { task } }]);
    }
  });

  it('maintain --full: compact --full sends full true, and all and the default accept it', async () => {
    const compact = harness(maintainReply);
    assert.equal(await compact.run(['maintain', 'compact', '--full']), 0);
    assert.deepEqual(compact.requests[0]?.args, { task: 'compact', full: true });
    const all = harness(maintainReply);
    assert.equal(await all.run(['maintain', 'all', '--full']), 0);
    assert.deepEqual(all.requests[0]?.args, { task: 'all', full: true });
    const bare = harness(maintainReply);
    assert.equal(await bare.run(['maintain', '--full']), 0);
    assert.deepEqual(bare.requests[0]?.args, { task: 'all', full: true });
  });

  it('maintain --full with any other task is a usage error', async () => {
    for (const task of ['reconcile', 'resolve', 'refresh', 'collect', 'check']) {
      const h = harness(maintainReply);
      assert.equal(await h.run(['maintain', task, '--full']), 1, task);
      assert.deepEqual(h.requests, []);
      assert.match(h.stderr.join(''), /--full/);
    }
  });

  it('unknown task: an unknown task name and a second positional are usage errors that name the tasks', async () => {
    for (const argv of [['maintain', 'vacuum'], ['maintain', 'collect', 'compact'], ['maintain', 'ALL']]) {
      const h = harness(maintainReply);
      assert.equal(await h.run(argv), 1, `argv ${JSON.stringify(argv)}`);
      assert.deepEqual(h.requests, []);
    }
    const named = harness(maintainReply);
    await named.run(['maintain', 'vacuum']);
    assert.match(named.stderr.join(''), /reconcile, resolve, refresh, collect, compact, check, all/);
  });

  it('a lease_held reply exits 3 and prints the envelope unchanged', async () => {
    const held: Envelope = {
      schema: 'gsd-atlas.error/1',
      ok: false,
      data: null,
      diagnostics: [{ code: 'lease_held', severity: 'error', message: 'Another gsd-atlas process holds the writer for this repository.' }],
    };
    const h = harness(held);
    assert.equal(await h.run(['maintain', 'collect']), 3);
    assert.deepEqual(h.stdout.map((line) => JSON.parse(line)), [held]);
  });
});

describe('status --since', () => {
  const statusReply = okReply('gsd-atlas.status/1');

  it('status --since defaults to 7d and sends kind status', async () => {
    const h = harness(statusReply);
    assert.equal(await h.run(['status', '--repo', REPO]), 0);
    assert.deepEqual(h.requests, [{ protocol: PROTOCOL_VERSION, kind: 'status', args: { repo: REPO, since: '7d' } }]);
  });

  it('status --since accepts 30m, 24h, 7d and 30d', async () => {
    for (const since of ['30m', '24h', '7d', '30d']) {
      const h = harness(statusReply);
      assert.equal(await h.run(['status', '--since', since]), 0, since);
      assert.deepEqual(h.requests[0]?.args, { since });
    }
  });

  it('status --since rejects anything but a count and a unit of m, h or d', async () => {
    for (const since of ['', '7', 'd', '7x', '0d', '-1d', '1.5d', '10000d', 'week', '7 d', '7D']) {
      const h = harness(statusReply);
      assert.equal(await h.run(['status', `--since=${since}`]), 1, JSON.stringify(since));
      assert.deepEqual(h.requests, []);
    }
    const extra = harness(statusReply);
    assert.equal(await extra.run(['status', 'now']), 1);
  });

  it('status exits 0 when recording is off, printing the envelope unchanged', async () => {
    const off: Envelope = {
      schema: 'gsd-atlas.status/1',
      ok: true,
      data: { report: { tokens: { estimatedTotal: 0, byTool: {}, label: 'estimate' } }, tenant: { metrics: { recording: false, reason: 'disabled' } } },
      diagnostics: [],
    };
    const h = harness(off);
    assert.equal(await h.run(['status']), 0);
    assert.deepEqual(h.stdout.map((line) => JSON.parse(line)), [off]);
    assert.deepEqual(h.stderr, []);
  });

  it('an overflow flag on a latency histogram reaches stdout untouched', async () => {
    const histogram = { count: 3, p50UpperBoundMs: 5000, p95UpperBoundMs: 5000, overflow: true, buckets: { le5000: 1, inf: 2 } };
    const reply: Envelope = { schema: 'gsd-atlas.status/1', ok: true, data: { report: { answers: { latency: histogram } } }, diagnostics: [] };
    const h = harness(reply);
    assert.equal(await h.run(['status']), 0);
    const printed = JSON.parse(h.stdout[0] as string) as { data: { report: { answers: { latency: typeof histogram } } } };
    assert.deepEqual(printed.data.report.answers.latency, histogram);
  });
});

describe('usage text', () => {
  it('names every command', async () => {
    const h = harness(okReply('gsd-atlas.x/1'));
    await h.run(['--help']);
    const text = h.stdout.join('');
    for (const word of ['find', 'refs', 'context', 'impact', 'health', 'build', 'maintain', 'status', 'init', 'lang list', 'lang test', '--since', '--full', '--depth', '--path']) {
      assert.ok(text.includes(word), word);
    }
  });
});
