/**
 * `explain` end to end (QRY-07, D-18, plan 03-26): the real `gsd-atlas` and `gsd-atlas-mcp` bins, started through the
 * CommandRunner in an isolated environment, over a temporary git repository with a `.cts` library that a `.cts` user and a
 * `.cjs` script outside every tsconfig both call. The `.cjs` call site stays at the grammar tier by design; the `.cts` ones
 * become precise. Nothing here wires a test hook.
 *
 * It lives under scripts because the adapter lint forbids src/cli tests from importing any module but host-client.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../src/test-kit/index.ts';
import type { TempDir, TempGitRepo } from '../src/test-kit/index.ts';
import { CLI_BIN, maskNonce } from './test-helpers/fixture-repo.ts';
import { startMcp } from './test-helpers/mcp-client.ts';
import type { McpClient } from './test-helpers/mcp-client.ts';

const decoder = new TextDecoder();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TSCONFIG = JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true, target: 'es2022' }, include: ['src'] }, null, 2);

export const FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': TSCONFIG,
  'src/lib.cts': 'export function compute(n: number): number {\n  return n + 1;\n}\n',
  'src/user.cts': ["import { compute } from './lib.cjs';", '', 'export function run(): number {', '  return compute(1);', '}', ''].join('\n'),
  'scripts/legacy.cjs': "const { compute } = require('../src/lib.cjs');\n\nmodule.exports = function legacy() {\n  return compute(2);\n};\n",
};

export interface Envelope {
  readonly schema: string;
  readonly ok: boolean;
  readonly data: unknown;
  readonly degraded?: readonly string[];
  readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly message: string }>;
  readonly citations?: ReadonlyArray<{ readonly id: string; readonly path: string; readonly debug: string; readonly line: number }>;
  readonly answer_id?: string;
  readonly [key: string]: unknown;
}

export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: Envelope;
}

export interface Fixture {
  readonly dir: string;
  readonly tmp: TempDir;
  readonly repo: TempGitRepo;
  cli(args: readonly string[]): Promise<Run>;
  mcp(): McpClient;
  cleanup(): Promise<void>;
}

export async function makeFixture(files: Readonly<Record<string, string>> = FILES): Promise<Fixture> {
  const setup = createRealRunner({ decide: allowAll });
  const tmp = makeTempDir();
  const started: McpClient[] = [];
  const repo = await createTempGitRepo({ runner: setup, world: { committed: files } });
  const outside = path.join(realPath(tmp.path), 'outside');
  fs.mkdirSync(outside);
  const env: Record<string, string> = { ...repo.envOverlay, GSD_ATLAS_USER_DIR: path.join(tmp.path, 'user') };
  const runner = createRealRunner({ decide: allowAll });
  return {
    dir: repo.dir,
    tmp,
    repo,
    async cli(args) {
      const result = await runner.run({ executable: process.execPath, args: [CLI_BIN, ...args], cwd: outside, env });
      assert.equal(result.spawnError, undefined, 'the gsd-atlas bin must start');
      const stdout = decoder.decode(result.stdout);
      const stderr = decoder.decode(result.stderr);
      let envelope = {} as Envelope;
      if (stdout !== '') {
        assert.ok(stdout.endsWith('\n') && stdout.indexOf('\n') === stdout.length - 1, `stdout must be one JSON line, got ${JSON.stringify(stdout)}`);
        envelope = JSON.parse(stdout) as Envelope;
      }
      return { code: result.exitCode, stdout, stderr, envelope };
    },
    mcp() {
      const server = startMcp({ cwd: outside, env });
      started.push(server);
      return server;
    },
    async cleanup() {
      for (const server of started) await server.killAndStderr();
      started.length = 0;
      tmp.cleanup();
      repo.cleanup();
    },
  };
}

export async function withFixture(fixture: Fixture, body: (fixture: Fixture) => Promise<void>): Promise<void> {
  try {
    await body(fixture);
  } finally {
    await fixture.cleanup();
  }
}

/** The `debug` handle of the citation of `refs compute` that sits in `file`. */
export async function handleIn(fixture: Fixture, file: string, name = 'compute'): Promise<string> {
  for (let read = 0; read < 12; read += 1) {
    const refs = await fixture.cli(['refs', name, '--repo', fixture.dir, '--path', 'src/lib.cts']);
    assert.equal(refs.code, 0, refs.stderr);
    const found = (refs.envelope.citations ?? []).find((citation) => citation.path === file);
    if (found !== undefined && !(refs.envelope.degraded ?? []).includes('resolver_timeout')) return found.debug;
    await sleep(400);
  }
  assert.fail(`no citation in ${file}`);
}

interface Explained {
  readonly explanation: {
    readonly handle: string;
    readonly kind: string;
    readonly fact: {
      readonly extractor: string;
      readonly tier: string;
      readonly confidence: string;
      readonly module: string;
      readonly grammarVersion: string;
      readonly stale: boolean;
      readonly path: string;
      readonly contentHash: string;
    };
    readonly resolution: { readonly cache: string; readonly contextId: string; readonly configHashCount: number; readonly resolver?: string; readonly target?: { readonly name: string; readonly kind: string; readonly path: string } } | null;
    readonly overlay: { readonly worktree: string; readonly seq: number; readonly stalePaths: number };
  };
  readonly tiers: { readonly grammar: string; readonly precise: string; readonly compiler?: { readonly name: string; readonly version: string; readonly source: string; readonly case: string } };
}

export const explainedOf = (envelope: Envelope): Explained => envelope.data as Explained;

describe('explain over the real bins (QRY-07): a reference fact at the grammar tier', () => {
  it('the CLI explains a refs citation handle and the MCP tool returns the same data', async () => {
    await withFixture(await makeFixture(), async (fixture) => {
      assert.equal((await fixture.cli(['build', '--repo', fixture.dir])).code, 0);
      const handle = await handleIn(fixture, 'scripts/legacy.cjs');

      const cli = await fixture.cli(['explain', handle, '--repo', fixture.dir]);
      assert.equal(cli.code, 0, cli.stderr);
      assert.equal(cli.envelope.ok, true, JSON.stringify(cli.envelope.diagnostics));
      assert.equal(cli.envelope.schema, 'gsd-atlas.code-explain/1');
      const data = explainedOf(cli.envelope);
      assert.equal(data.explanation.handle, handle);
      assert.equal(data.explanation.kind, 'reference');
      assert.match(data.explanation.fact.extractor, /^grammar:typescript@\d+\.\d+\.\d+$/);
      assert.equal(data.explanation.fact.tier, 'grammar');
      assert.equal(data.explanation.fact.confidence, 'INFERRED');
      assert.equal(data.explanation.fact.grammarVersion, data.explanation.fact.extractor.split('@')[1]);
      assert.equal(data.explanation.fact.path, 'scripts/legacy.cjs');
      assert.match(data.explanation.fact.contentHash, /^[0-9a-f]{40}$/);
      assert.ok(data.explanation.overlay.seq >= 1);
      assert.ok(['not_asked', 'asked_no_edge'].includes(data.explanation.resolution?.cache ?? ''), JSON.stringify(data.explanation.resolution));
      assert.equal(data.tiers.grammar, 'active');
      assert.ok(typeof cli.envelope.answer_id === 'string');

      const server = fixture.mcp();
      await server.initialize();
      const call = await server.callTool('code_explain', { handle, repo: fixture.dir });
      assert.notEqual(call.result.isError, true, call.result.content[0]?.text);
      assert.equal(maskNonce(cli.stdout.trimEnd()), maskNonce(call.result.content[0]?.text ?? ''), 'CLI and MCP return the same JSON, answer_id aside');
      assert.deepStrictEqual((call.envelope as unknown as Envelope).data, cli.envelope.data);
      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });

  it('a definition handle is EXTRACTED with no resolution, and a bad handle is a fixed invalid_handle error', async () => {
    await withFixture(await makeFixture(), async (fixture) => {
      assert.equal((await fixture.cli(['build', '--repo', fixture.dir])).code, 0);
      const found = await fixture.cli(['find', 'compute', '--repo', fixture.dir]);
      const definition = (found.envelope.citations ?? [])[0]?.debug ?? '';
      assert.match(definition, /^sym\//);

      const explained = await fixture.cli(['explain', definition, '--repo', fixture.dir]);
      assert.equal(explained.code, 0, explained.stderr);
      const data = explainedOf(explained.envelope);
      assert.equal(data.explanation.kind, 'symbol');
      assert.equal(data.explanation.fact.confidence, 'EXTRACTED');
      assert.equal(data.explanation.resolution, null);

      const marker = 'ECHO-THIS-BACK';
      const bad = await fixture.cli(['explain', `nonsense/${marker}`, '--repo', fixture.dir]);
      assert.equal(bad.code, 2, bad.stderr);
      assert.equal(bad.envelope.ok, false);
      assert.equal(bad.envelope.diagnostics[0]?.code, 'invalid_handle');
      assert.equal(JSON.stringify(bad.envelope).includes(marker), false, 'the handle is not echoed');
      assert.equal(bad.stderr.includes(marker), false);
    });
  });
});
