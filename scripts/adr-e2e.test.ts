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

describe('the repository config names the ADR directory (ADR 5 amendment, point 4)', () => {
  const FILES: Readonly<Record<string, string>> = {
    ...ADR_FILES,
    'documentation/decisions/0001-configured.md': '# configured\n',
    '.gsd-atlas/config.json': JSON.stringify({ adrDirs: ['documentation/decisions'], permissions: { allow: [{ executable: 'node' }] }, autoSubmit: true }),
  };

  it('repo config replaces the list: ADR-1 resolves in the configured directory only, with one fixed note for the ignored keys', async () => {
    await withAdrFixture(FILES, async (fixture) => {
      assert.equal((await fixture.cli(['build', '--repo', fixture.dir])).code, 0);
      const one = await fixture.cli(['refs', 'ADR-1', '--kind', 'adr', '--repo', fixture.dir]);
      assert.equal(one.code, 0, one.stderr);
      assert.deepEqual((one.envelope.data as RefsData).adr, { number: 1, status: 'resolved', files: ['documentation/decisions/0001-configured.md'] });
      assert.deepEqual(one.envelope.diagnostics.filter((d) => d.code === 'repo_config_ignored').length, 1);
      // docs/adr is no longer searched: ADR 2 has a file there only.
      const two = await fixture.cli(['refs', '2', '--kind', 'adr', '--repo', fixture.dir]);
      assert.deepEqual((two.envelope.data as RefsData).adr, { number: 2, status: 'unresolved', files: [] });
      // The ignored keys enabled nothing: the repository is still not allowed to run a command.
      assert.equal(one.stderr, '');
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Task 3: the three surfaces, CLI and MCP parity, duplicate and missing ADR ids, cit handles

/** gsd-core's shape: ADR 0010 has two files, 0011 one, and 12 is cited but has none; a string literal mentions ADR-12 too. */
export const DUPLICATE_FILES: Readonly<Record<string, string>> = {
  'docs/adr/0010-b-second.md': '# b\n',
  'docs/adr/0010-a-first.md': '# a\n',
  'docs/adr/0011-only.md': '# c\n',
  'src/a.cts': '/** Uses ADR-10. */\nexport function ten(): number {\n  return 10;\n}\n',
  'src/b.cts': '// ADR #11 §2\nexport function eleven(): number {\n  return 11;\n}\n',
  'src/c.cts': 'const note = "ADR-12 is in a string";\n// but ADR-12 is cited here\nexport function twelve(): number {\n  return 12;\n}\n',
};

// ---------------------------------------------------------------------------------------------
// Task 5 (amendment of 2026-10-18): the gap diagnostic, citations.filesWithGaps and the build note, across builds

/** A header block over the comment size bound (32,768 units) and a file with 201 mentions: two files whose citations cannot all be stored. */
const GAP_FILES: Readonly<Record<string, string>> = {
  'docs/adr/0007-seven.md': '# seven\n',
  'src/ok.cts': '// see ADR-7\nexport function ok(): number {\n  return 7;\n}\n',
  'src/header.cts': `/* HEADER-MARKER ${'x'.repeat(33_000)} ADR-7 */\nexport function header(): number {\n  return 1;\n}\n`,
  'src/many.cts': `${Array.from({ length: 201 }, (_, i) => `// ADR-8 mention ${String(i)}`).join('\n')}\nexport function many(): number {\n  return 8;\n}\n`,
};

const TWO_FILES_NOTE = '2 files have ADR mentions that are not indexed (a comment over the comment size bound, or more than 200 mentions in one file); citations from them are missing';
const MAY_BE_MISSING = 'Citations may be missing from this answer: 2 files have ADR mentions that were not indexed (a comment over the comment size bound, or more than 200 mentions in one file).';

const codesOf = (run: Run): string[] => run.envelope.diagnostics.map((d) => d.code);
const gapDiagnostics = (run: Run): Array<{ code: string; severity: string; message: string; subject?: string }> =>
  run.envelope.diagnostics.filter((d) => d.code === 'citation_comment_too_long');
const filesWithGaps = (run: Run): unknown => (run.envelope.data as { citations?: { filesWithGaps?: unknown } }).citations?.filesWithGaps;

describe('the citation gap is visible on ADR answers and in atlas_status, and survives a build that changes nothing', () => {
  it('no-op build keeps the diagnostic and the count: build, a second build, then an unrelated file added', async () => {
    await withAdrFixture(GAP_FILES, async (fixture) => {
      const check = async (step: string): Promise<void> => {
        const refs = await fixture.cli(['refs', 'ADR-7', '--kind', 'adr', '--repo', fixture.dir]);
        assert.equal(refs.code, 0, `${step}: ${refs.stderr}`);
        assert.deepEqual(gapDiagnostics(refs).map((d) => [d.severity, d.message, d.subject]), [['info', MAY_BE_MISSING, undefined]], `${step}: refs`);
        const find = await fixture.cli(['find', 'ADR-7', '--kind', 'adr', '--repo', fixture.dir]);
        assert.deepEqual(gapDiagnostics(find).map((d) => d.message), [MAY_BE_MISSING], `${step}: find`);
        const health = await fixture.cli(['health', '--repo', fixture.dir]);
        assert.equal(filesWithGaps(health), 2, `${step}: atlas_status`);
        assert.equal((health.envelope.data as { health: string }).health, 'ok', `${step}: a gap alone is not a health reason`);
        assert.deepEqual((health.envelope.data as { reasons: string[] }).reasons, []);
        assert.equal(health.envelope.degraded, undefined);
      };

      const first = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(first.code, 0, first.stderr);
      await check('after the first build');

      const second = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal((second.envelope.data as { parsed: number }).parsed, 0, 'the second build parsed nothing');
      await check('after a build that changes nothing');

      fixture.repo.write('src/extra.cts', 'export function extra(): number {\n  return 3;\n}\n');
      const third = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal((third.envelope.data as { parsed: number }).parsed, 1);
      await check('after an unrelated file was added');
    });
  });

  it('no-op build envelope carries the note: the second build says so in diagnostics while its data keys are unchanged', async () => {
    await withAdrFixture(GAP_FILES, async (fixture) => {
      const first = await fixture.cli(['build', '--repo', fixture.dir]);
      const second = await fixture.cli(['build', '--repo', fixture.dir]);
      for (const run of [first, second]) {
        assert.deepEqual(gapDiagnostics(run).map((d) => [d.severity, d.message, d.subject]), [['info', TWO_FILES_NOTE, undefined]]);
      }
      assert.deepEqual(Object.keys(second.envelope.data as object).sort(), Object.keys(first.envelope.data as object).sort(), 'the documented data keys are unchanged');
      assert.equal((second.envelope.data as { parsed: number }).parsed, 0);
      assert.equal((second.envelope.data as { skipped: number }).skipped, (first.envelope.data as { skipped: number }).skipped);
      assert.ok(codesOf(second).every((code) => ['emit_output_not_indexed', 'citation_comment_too_long', 'resolver_timeout'].includes(code)));
    });
  });

  it('gap diagnostic parity CLI and MCP: code_refs, code_find and atlas_status agree on the diagnostic and the count', async () => {
    await withAdrFixture(GAP_FILES, async (fixture) => {
      assert.equal((await fixture.cli(['build', '--repo', fixture.dir])).code, 0);
      const refs = await fixture.cli(['refs', 'ADR-7', '--kind', 'adr', '--repo', fixture.dir]);
      const find = await fixture.cli(['find', 'ADR-8', '--kind', 'adr', '--repo', fixture.dir]);
      const health = await fixture.cli(['health', '--repo', fixture.dir]);
      // ADR 8 has no file and is cited 200 times in the stored part of one file: the answer says it may be incomplete, not "nobody cites it".
      assert.deepEqual(gapDiagnostics(find).map((d) => d.message), [MAY_BE_MISSING]);

      const server = fixture.mcp();
      await server.initialize();
      const viaRefs = await server.callTool('code_refs', { name: 'ADR-7', kind: 'adr', repo: fixture.dir });
      assert.equal(maskNonce(refs.stdout.trimEnd()), maskNonce(viaRefs.result.content[0]?.text ?? ''), 'code_refs');
      const viaFind = await server.callTool('code_find', { name: 'ADR-8', kind: 'adr', repo: fixture.dir });
      assert.equal(maskNonce(find.stdout.trimEnd()), maskNonce(viaFind.result.content[0]?.text ?? ''), 'code_find');
      const viaStatus = await server.callTool('atlas_status', { repo: fixture.dir });
      const statusData = viaStatus.envelope.data as { citations: unknown; health: string };
      assert.deepEqual(statusData.citations, { filesWithGaps: 2 });
      assert.deepEqual((health.envelope.data as { citations: unknown }).citations, { filesWithGaps: 2 });
      assert.ok(!(statusData as unknown as { reasons: string[] }).reasons.includes('stale_files'), 'a gap is not a stale file');
      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });

  it('a repository without a gap has no diagnostic on ADR answers, a zero count in atlas_status and no build note', async () => {
    await withAdrFixture(ADR_FILES, async (fixture) => {
      const built = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.deepEqual(gapDiagnostics(built), []);
      const refs = await fixture.cli(['refs', 'ADR-1', '--kind', 'adr', '--repo', fixture.dir]);
      assert.deepEqual(refs.envelope.diagnostics, []);
      const none = await fixture.cli(['find', 'ADR-404', '--kind', 'adr', '--repo', fixture.dir]);
      assert.deepEqual(none.envelope.diagnostics, []);
      assert.equal(filesWithGaps(await fixture.cli(['health', '--repo', fixture.dir])), 0);
    });
  });

  it('the envelopes never carry the names of the gap files or the text of the header block', async () => {
    await withAdrFixture(GAP_FILES, async (fixture) => {
      const built = await fixture.cli(['build', '--repo', fixture.dir]);
      const runs = [
        built,
        await fixture.cli(['refs', 'ADR-7', '--kind', 'adr', '--repo', fixture.dir]),
        await fixture.cli(['find', 'ADR-7', '--kind', 'adr', '--repo', fixture.dir]),
        await fixture.cli(['health', '--repo', fixture.dir]),
      ];
      for (const run of runs) {
        for (const leak of ['header.cts', 'many.cts', 'HEADER-MARKER', 'xxxxxxxx']) assert.equal(run.stdout.includes(leak), false, leak);
      }
    });
  });
});

interface FindRows {
  readonly number: number;
  readonly status: string;
  readonly citations: number;
  readonly results: ReadonlyArray<{ readonly path: string; readonly confidence: string }>;
}

describe('code_find, code_refs and code_context with ADR citations: CLI and MCP agree (TSM-04)', () => {
  it('statuses: 10 is ambiguous, 11 resolved, 12 unresolved with its one real citation; the mention inside a string literal is not a citation', async () => {
    await withAdrFixture(DUPLICATE_FILES, async (fixture) => {
      assert.equal((await fixture.cli(['build', '--repo', fixture.dir])).code, 0);
      const ten = await fixture.cli(['find', 'ADR-10', '--kind', 'adr', '--repo', fixture.dir]);
      const tenData = ten.envelope.data as FindRows;
      assert.deepEqual({ status: tenData.status, citations: tenData.citations }, { status: 'ambiguous', citations: 1 });
      assert.deepEqual(tenData.results.map((row) => [row.path, row.confidence]), [
        ['docs/adr/0010-a-first.md', 'INFERRED'],
        ['docs/adr/0010-b-second.md', 'INFERRED'],
      ]);
      const eleven = (await fixture.cli(['find', '11', '--kind', 'adr', '--repo', fixture.dir])).envelope.data as FindRows;
      assert.deepEqual([eleven.status, eleven.results.map((row) => row.path)], ['resolved', ['docs/adr/0011-only.md']]);
      const twelve = await fixture.cli(['find', 'adr 12', '--kind', 'adr', '--repo', fixture.dir]);
      const twelveData = twelve.envelope.data as FindRows;
      assert.deepEqual({ status: twelveData.status, citations: twelveData.citations, results: twelveData.results }, { status: 'unresolved', citations: 1, results: [] });
      assert.equal((twelve.envelope.hints ?? []).length, 1);

      const refs = await fixture.cli(['refs', 'ADR-12', '--kind', 'adr', '--repo', fixture.dir]);
      const refsData = refs.envelope.data as RefsData;
      assert.equal(refsData.results.length, 1, 'only the comment on line 2, not the string literal on line 1');
      assert.equal(refsData.results[0]?.line, 2);
    });
  });

  it('CLI and MCP return the same JSON for code_find, code_refs and code_context', async () => {
    await withAdrFixture(DUPLICATE_FILES, async (fixture) => {
      assert.equal((await fixture.cli(['build', '--repo', fixture.dir])).code, 0);

      const pairs: ReadonlyArray<{ readonly label: string; readonly cli: readonly string[]; readonly tool: string; readonly args: Record<string, unknown> }> = [
        { label: 'code_find', cli: ['find', 'ADR-10', '--kind', 'adr'], tool: 'code_find', args: { name: 'ADR-10', kind: 'adr' } },
        { label: 'code_refs', cli: ['refs', 'ADR-11', '--kind', 'adr'], tool: 'code_refs', args: { name: 'ADR-11', kind: 'adr' } },
        { label: 'code_context', cli: ['context', 'ten'], tool: 'code_context', args: { name: 'ten' } },
      ];
      // The CLI runs first, one process at a time, so each is the writer-lease holder; the MCP server then is, and the answers are
      // compared like for like (a process that does not hold the lease marks its answers `follower`).
      const fromCli: string[] = [];
      for (const pair of pairs) {
        const cli = await fixture.cli([...pair.cli, '--repo', fixture.dir]);
        assert.equal(cli.code, 0, cli.stderr);
        fromCli.push(maskNonce(cli.stdout.trimEnd()));
      }
      const server = fixture.mcp();
      await server.initialize();
      for (const [index, pair] of pairs.entries()) {
        const call = await server.callTool(pair.tool, { ...pair.args, repo: fixture.dir });
        assert.equal(fromCli[index], maskNonce(call.result.content[0]?.text ?? ''), pair.label);
      }
      const context = (await fixture.cli(['context', 'ten', '--repo', fixture.dir])).envelope.data as {
        citations?: ReadonlyArray<{ number: number; status: string; files: string[] }>;
      };
      assert.deepEqual(context.citations?.map((entry) => [entry.number, entry.status, entry.files]), [[10, 'ambiguous', ['docs/adr/0010-a-first.md', 'docs/adr/0010-b-second.md']]]);

      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });

  it('explain of a citation handle says it is a citation of the grammar tier, with the number and the ADR status, identically over the CLI and MCP', async () => {
    await withAdrFixture(DUPLICATE_FILES, async (fixture) => {
      assert.equal((await fixture.cli(['build', '--repo', fixture.dir])).code, 0);
      const refs = await fixture.cli(['refs', 'ADR-11', '--kind', 'adr', '--repo', fixture.dir]);
      const handle = (refs.envelope['citations'] as ReadonlyArray<{ debug: string }>)[0]?.debug ?? '';
      assert.match(handle, /^cit\//);
      const explained = await fixture.cli(['explain', handle, '--repo', fixture.dir]);
      assert.equal(explained.code, 0, explained.stderr);
      const data = explained.envelope.data as { explanation: { kind: string; resolution: unknown; citation: { number: number; detail?: string } }; adr: { status: string; files: string[] } };
      assert.equal(data.explanation.kind, 'citation');
      assert.equal(data.explanation.resolution, null);
      assert.deepEqual(data.explanation.citation, { number: 11, detail: '§2' });
      assert.deepEqual(data.adr, { number: 11, status: 'resolved', files: ['docs/adr/0011-only.md'] });

      const server = fixture.mcp();
      await server.initialize();
      const call = await server.callTool('code_explain', { handle, repo: fixture.dir });
      assert.equal(maskNonce(explained.stdout.trimEnd()), maskNonce(call.result.content[0]?.text ?? ''));
      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });
});
