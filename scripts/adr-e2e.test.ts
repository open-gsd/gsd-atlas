/**
 * ADR citations end to end (TSM-04, plan 03-28): the real `gsd-atlas` and `gsd-atlas-mcp` bins, started through the CommandRunner
 * in an isolated environment, over temporary git repositories whose comments cite ADRs and whose `docs/adr` directory holds some
 * of the cited documents.
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

interface Envelope {
  readonly schema: string;
  readonly ok: boolean;
  readonly data: unknown;
  readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly severity: string; readonly message: string; readonly subject?: string }>;
  readonly degraded?: readonly string[];
  readonly hints?: readonly string[];
  readonly [key: string]: unknown;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: Envelope;
}

export interface AdrFixture {
  readonly dir: string;
  readonly tmp: TempDir;
  readonly repo: TempGitRepo;
  cli(args: readonly string[]): Promise<Run>;
  mcp(): McpClient;
  cleanup(): Promise<void>;
}

/** A fixture repository, an isolated environment, and the two bins. */
export async function makeAdrFixture(files: Readonly<Record<string, string>>): Promise<AdrFixture> {
  const tmp = makeTempDir();
  const started: McpClient[] = [];
  const repo = await createTempGitRepo({ runner: createRealRunner({ decide: allowAll }), world: { committed: files } });
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

/** Run `body` over a fixture and always clean up. */
export async function withAdrFixture(files: Readonly<Record<string, string>>, body: (fixture: AdrFixture) => Promise<void>): Promise<void> {
  const fixture = await makeAdrFixture(files);
  try {
    await body(fixture);
  } finally {
    await fixture.cleanup();
  }
}

// ---------------------------------------------------------------------------------------------
// The repository of the tracer: two ADR files (1 and 2), `src/lib.cts` cites ADR-1 in a doc comment above `load`, and
// `src/user.cts` cites `ADR #2 §3` and `adr 0003` (no file for 3).

export const ADR_FILES: Readonly<Record<string, string>> = {
  'docs/adr/0001-first.md': '# First decision\n',
  'docs/adr/2-second.md': '# Second decision\n',
  'src/lib.cts': '/** See ADR-1. */\nexport function load(): number {\n  return 1;\n}\n',
  'src/user.cts': '// ADR #2 §3 and adr 0003\nexport function use(): number {\n  return 2;\n}\n',
};

interface Row {
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly detail?: string;
  readonly attachedTo: string | null;
  readonly confidence: string;
  readonly citation: string;
}

interface RefsData {
  readonly adr: { readonly number: number; readonly status: string; readonly files: readonly string[] };
  readonly results: readonly Row[];
}

describe('ADR citations tracer: which code cites ADR N, through the CLI', () => {
  it('after build, refs ADR-1 --kind adr lists the JSDoc citation attached to load and the resolved ADR file; 2 keeps the detail; adr-3 is unresolved', async () => {
    await withAdrFixture(ADR_FILES, async (fixture) => {
      const built = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(built.code, 0, built.stderr);

      const one = await fixture.cli(['refs', 'ADR-1', '--kind', 'adr', '--repo', fixture.dir]);
      assert.equal(one.code, 0, one.stderr);
      assert.equal(one.envelope.schema, 'gsd-atlas.code-refs/1');
      const first = one.envelope.data as RefsData;
      assert.deepEqual(first.adr, { number: 1, status: 'resolved', files: ['docs/adr/0001-first.md'] });
      assert.equal(first.results.length, 1);
      assert.deepEqual(
        { path: first.results[0]?.path, line: first.results[0]?.line, attachedTo: first.results[0]?.attachedTo, confidence: first.results[0]?.confidence },
        { path: 'src/lib.cts', line: 1, attachedTo: 'load', confidence: 'EXTRACTED' },
      );

      const two = await fixture.cli(['refs', '2', '--kind', 'adr', '--repo', fixture.dir]);
      const second = two.envelope.data as RefsData;
      assert.deepEqual(second.adr, { number: 2, status: 'resolved', files: ['docs/adr/2-second.md'] });
      assert.equal(second.results[0]?.detail, '§3');

      const three = await fixture.cli(['refs', 'adr-3', '--kind', 'adr', '--repo', fixture.dir]);
      const third = three.envelope.data as RefsData;
      assert.deepEqual(third.adr, { number: 3, status: 'unresolved', files: [] });
      assert.equal(third.results.length, 1);
      assert.equal(third.results[0]?.path, 'src/user.cts');
    });
  });

  it('over MCP the same request returns the same JSON as the CLI', async () => {
    await withAdrFixture(ADR_FILES, async (fixture) => {
      assert.equal((await fixture.cli(['build', '--repo', fixture.dir])).code, 0);
      const cli = await fixture.cli(['refs', 'ADR-1', '--kind', 'adr', '--repo', fixture.dir]);
      const server = fixture.mcp();
      await server.initialize();
      const call = await server.callTool('code_refs', { name: 'ADR-1', kind: 'adr', repo: fixture.dir });
      assert.equal(maskNonce(cli.stdout.trimEnd()), maskNonce(call.result.content[0]?.text ?? ''));
      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });
});
