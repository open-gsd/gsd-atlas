/**
 * CLI and MCP parity as real processes (QRY-04, QRY-05; plan 02-25): the same request against the same index returns
 * identical JSON from `src/bin/gsd-atlas.ts` and from `src/bin/gsd-atlas-mcp.ts`. Both are started through the
 * CommandRunner (`createRealRunner`, no shell) in an isolated environment (HOME, user directory, git configuration).
 *
 * The comparison is on strings: the CLI's stdout line equals the MCP result text after the per-response nonce is
 * replaced by a fixed token. Nothing else is masked, except the one named clock field of `atlas_status` (see the
 * health case, which compares two SETTLED snapshots: each surface is asked until the product itself reports no
 * Reconcile in flight, because the two surfaces are two processes with a start-up Reconcile each and an answer given
 * mid-Reconcile is honestly `reconciling`). A failure prints the stderr of both processes.
 *
 * Order matters and is deliberate: a CLI run is its own process, so it is the writer-lease leader only while no MCP
 * server holds the lease. Every case therefore runs its CLI requests first (each process exits and releases the
 * lease) and starts the server afterwards, so both surfaces answer as the leader and the answers are comparable
 * byte for byte. The two-process case, where one of them is a follower, is in product-e2e.test.ts.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { FORGED_FENCE, INJECTION_SENTENCE, maskNonce, withFixture } from './test-helpers/fixture-repo.ts';
import type { CliRun, FixtureRepo } from './test-helpers/fixture-repo.ts';
import type { Envelope } from './test-helpers/mcp-client.ts';
import { untilSettled } from './test-helpers/settle.ts';

interface Row {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly citation: string;
  readonly [key: string]: unknown;
}

const rowsOf = (envelope: Envelope): Row[] => (envelope.data as { results: Row[] }).results;

/** How often and how long the health case asks before it gives up on the product settling. */
const SETTLE = { attempts: 40, delayMs: 250 } as const;

/** The product's own word for at rest: no Reconcile in flight, nothing queued or running, healthy, and a Reconcile has finished once. */
function isSettled(envelope: Envelope): boolean {
  const data = envelope.data as { health?: string; indexer?: { reconciling?: boolean; queued?: number; running?: number; lastReconcileAt?: number | null } } | undefined;
  const indexer = data?.indexer;
  return (
    data?.health === 'ok' &&
    indexer?.reconciling === false &&
    indexer.queued === 0 &&
    indexer.running === 0 &&
    typeof indexer.lastReconcileAt === 'number'
  );
}

/** The one JSON line a CLI run printed, without its newline. */
function cliLine(run: CliRun): string {
  assert.ok(run.stdout.endsWith('\n') && run.stdout.indexOf('\n') === run.stdout.length - 1, `stdout must be one JSON line, got ${JSON.stringify(run.stdout)}`);
  return run.stdout.slice(0, -1);
}

/** Build the index with the CLI; the process exits afterwards, so the lease is free for the next process. */
async function build(fixture: FixtureRepo, repo = fixture.dir): Promise<void> {
  const built = await fixture.cli(['build', '--repo', repo]);
  assert.equal(built.code, 0, built.stderr);
}

/** One request, asked of both surfaces. */
interface Plan {
  readonly cli: readonly string[];
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** What the two surfaces answered to one {@link Plan}. */
interface Pair {
  readonly code: number | null;
  readonly line: string;
  readonly text: string;
  readonly isError: boolean | undefined;
  readonly envelope: Envelope;
}

/**
 * Run every plan through the CLI (one process each), then through one MCP server, and assert that the CLI line equals
 * the MCP result text for each after `mask`. The mask defaults to replacing the nonce only.
 */
async function askBoth(fixture: FixtureRepo, plans: readonly Plan[], mask: (text: string) => string = maskNonce): Promise<Pair[]> {
  const runs: CliRun[] = [];
  for (const plan of plans) runs.push(await fixture.cli(plan.cli));
  const server = fixture.mcp();
  await server.initialize();
  const pairs: Pair[] = [];
  for (const [index, plan] of plans.entries()) {
    const run = runs[index] as CliRun;
    const line = cliLine(run);
    const call = await server.callTool(plan.tool, plan.args);
    const text = call.result.content[0]?.text ?? '';
    assert.equal(mask(line), mask(text), `the CLI line and the MCP result text for ${plan.tool} ${JSON.stringify(plan.args)} differ`);
    pairs.push({ code: run.code, line, text, isError: call.result.isError, envelope: call.envelope });
  }
  const exit = await server.close();
  assert.equal(exit.exitCode, 0, server.stderrText());
  return pairs;
}

describe('CLI and MCP parity on the TypeScript import chain', () => {
  it('find: the CLI stdout line equals the MCP result text after the nonce is masked, with the definition cited', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const [pair] = await askBoth(fixture, [{ cli: ['find', 'parse', '--repo', fixture.dir], tool: 'code_find', args: { name: 'parse', repo: fixture.dir } }]);
      assert.ok(pair !== undefined);
      assert.equal(pair.code, 0);
      assert.notEqual(pair.isError, true, pair.text);
      const envelope = pair.envelope;
      assert.equal(envelope.schema, 'gsd-atlas.code-find/1');
      assert.equal(envelope.ok, true);
      const first = rowsOf(envelope)[0];
      assert.equal(first?.name, 'parse');
      assert.equal(first?.path, 'a.ts');
      assert.equal(first?.line, 1);
      const citations = envelope['citations'] as Array<{ id: string; path: string }>;
      assert.ok(citations.some((citation) => citation.id === first?.citation && citation.path === 'a.ts'), 'the definition is cited');
      const fenced = envelope['untrusted_text'] as { nonce: string; entries: Array<{ text: string }> };
      assert.ok(fenced.nonce !== '' && fenced.entries.some((entry) => entry.text.includes('function parse')), 'the matched line is fenced');
    });
  });

  it('refs: identical JSON, with the call in b.ts inside load as the reference', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const [pair] = await askBoth(fixture, [{ cli: ['refs', 'parse', '--repo', fixture.dir], tool: 'code_refs', args: { name: 'parse', repo: fixture.dir } }]);
      assert.equal(pair?.envelope.schema, 'gsd-atlas.code-refs/1');
      assert.equal(pair.code, 0);
      assert.ok(rowsOf(pair.envelope).some((row) => row.path === 'b.ts' && row['enclosing'] === 'load' && row['confidence'] === 'INFERRED'));
    });
  });

  it('context: identical JSON, with the definition, its export and the reference', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const [pair] = await askBoth(fixture, [
        { cli: ['context', 'parse', '--repo', fixture.dir, '--path', 'a.ts'], tool: 'code_context', args: { name: 'parse', path: 'a.ts', repo: fixture.dir } },
      ]);
      assert.equal(pair?.envelope.schema, 'gsd-atlas.code-context/1');
      assert.equal(pair.code, 0);
      const sections = rowsOf(pair.envelope).map((row) => `${String(row['section'])}:${row.path}`);
      assert.deepEqual(sections, ['definition:a.ts', 'export:a.ts', 'reference:b.ts']);
    });
  });

  it('impact: identical JSON, and the four ADR-shaped items come back through both surfaces with their confidences', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const [pair] = await askBoth(fixture, [
        { cli: ['impact', 'parse', '--repo', fixture.dir, '--depth', '2'], tool: 'code_impact', args: { name: 'parse', depth: 2, repo: fixture.dir } },
      ]);
      assert.equal(pair?.envelope.schema, 'gsd-atlas.code-impact/1');
      assert.equal(pair.code, 0);
      const items = rowsOf(pair.envelope).map((row) => [row['hop'], row['via'], row.name, row['confidence'], row['chain_confidence']]);
      assert.deepEqual(items, [
        [1, 'call', 'load', 'INFERRED', 'INFERRED'],
        [1, 'import', 'b.ts', 'EXTRACTED', 'EXTRACTED'],
        [2, 'call', 'main', 'INFERRED', 'INFERRED'],
        [2, 'import', 'c.ts', 'EXTRACTED', 'EXTRACTED'],
      ]);
    });
  });

  it('health: identical JSON once both surfaces are settled, except the one clock field lastReconcileAt, which is masked by name and asserted to be a time', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const clock = /"lastReconcileAt":(\d+|null)/g;
      const seen: string[] = [];
      const mask = (text: string): string =>
        maskNonce(text).replace(clock, (_whole, value: string) => {
          seen.push(value);
          return '"lastReconcileAt":CLOCK';
        });
      // The two surfaces are two processes with a start-up Reconcile each (D-02: a request waits at most the approved
      // deadline and then honestly answers `reconciling`), so equality holds only when both are at rest. Each side is
      // asked until the PRODUCT says it is settled; a Reconcile that never ends fails with the last observation.
      const cli = await untilSettled(
        async () => {
          const run = await fixture.cli(['health', '--repo', fixture.dir]);
          const line = cliLine(run);
          return { run, line, envelope: JSON.parse(line) as Envelope };
        },
        (answer) => isSettled(answer.envelope),
        SETTLE,
      );
      const server = fixture.mcp();
      await server.initialize();
      const call = await untilSettled(() => server.callTool('atlas_status', { repo: fixture.dir }), (answer) => isSettled(answer.envelope), SETTLE);
      const text = call.result.content[0]?.text ?? '';
      assert.equal(mask(cli.line), mask(text), 'the CLI line and the MCP result text for atlas_status differ with both surfaces settled');
      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());

      assert.equal(cli.envelope.schema, 'gsd-atlas.atlas-status/1');
      assert.equal(cli.run.code, 0);
      assert.equal(seen.length, 2, 'the clock field was found exactly once in the CLI line and once in the MCP text');
      assert.ok(seen.every((value) => /^\d+$/.test(value)), `the reconcile time is a number on both surfaces, got ${seen.join(',')}`);
      // governor.running is not masked: the equality above compares it strictly.
      const data = cli.envelope.data as { health: string; store: { writerLeaseHeld: boolean } };
      assert.equal(data.health, 'ok');
      assert.equal(data.store.writerLeaseHeld, true);
    });
  });

  it('lang_list: the MCP tool lists typescript and javascript as built-in modules, and `lang list` prints the same module entries', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      const builtinDir = path.resolve(import.meta.dirname, '..', 'modules');
      const cli = await fixture.cli(['lang', 'list', '--builtin-dir', builtinDir]);
      assert.equal(cli.code, 0, cli.stderr);
      const server = fixture.mcp();
      await server.initialize();
      const call = await server.callTool('lang_list', {});
      assert.notEqual(call.result.isError, true);
      assert.equal(call.envelope.schema, 'gsd-atlas.lang-list/1');
      const fromMcp = (call.envelope.data as { modules: Array<{ id?: string; name?: string; source?: string }> }).modules;
      const fromCli = (JSON.parse(cliLine(cli)) as Envelope).data as { modules: unknown[] };
      const ids = fromMcp.map((module) => module.id ?? module.name);
      assert.ok(ids.includes('typescript') && ids.includes('javascript'), `built-in modules: ${JSON.stringify(ids)}`);
      assert.deepEqual(fromCli.modules, fromMcp);
      await server.close();
    });
  });
});

describe('CLI and MCP agree on failures and exit codes', () => {
  it('not_indexed exit 2: find on a never-built repository exits 2, and the MCP result is isError with the same JSON', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      const [pair] = await askBoth(fixture, [{ cli: ['find', 'parse', '--repo', fixture.dir], tool: 'code_find', args: { name: 'parse', repo: fixture.dir } }]);
      assert.equal(pair?.code, 2);
      assert.equal(pair.isError, true);
      assert.equal(pair.envelope.ok, false);
      assert.equal(pair.envelope.diagnostics[0]?.code, 'not_indexed');
    });
  });

  it('not_a_repo: a directory that is not a repository exits 2, and the MCP result is isError with the same JSON', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      const [pair] = await askBoth(fixture, [{ cli: ['find', 'parse', '--repo', fixture.outside], tool: 'code_find', args: { name: 'parse', repo: fixture.outside } }]);
      assert.equal(pair?.code, 2);
      assert.equal(pair.isError, true);
      assert.equal(pair.envelope.diagnostics[0]?.code, 'not_a_repo');
    });
  });

  it('usage exit 1: find with no name exits 1 with nothing on stdout, and bad numbers never reach the Host', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      const noName = await fixture.cli(['find', '--repo', fixture.dir]);
      assert.equal(noName.code, 1);
      assert.equal(noName.stdout, '');
      assert.match(noName.stderr, /Usage: gsd-atlas/);
      const badBudget = await fixture.cli(['find', 'parse', '--budget', 'many', '--repo', fixture.dir]);
      assert.equal(badBudget.code, 1);
      assert.equal(badBudget.stdout, '');
    });
  });

  it('exit 0 on the leaderless repository: build and maintain succeed when no other process holds the lease', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const maintained = await fixture.cli(['maintain', '--repo', fixture.dir]);
      assert.equal(maintained.code, 0, maintained.stderr);
      assert.equal((JSON.parse(cliLine(maintained)) as Envelope).ok, true);
      const rebuilt = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(rebuilt.code, 0, rebuilt.stderr);
    });
  });
});

describe('CLI and MCP agree on budgets and cursors', () => {
  it('budget cursor: a 40-token budget truncates with the same cursor on both surfaces, the second page is equal, and a changed cursor is bad_cursor on both', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const base = ['find', 'parse', '--mode', 'prefix', '--repo', fixture.dir];
      const first = await fixture.cli([...base, '--budget', '40']);
      assert.equal(first.code, 0, first.stderr);
      const page = JSON.parse(cliLine(first)) as Envelope;
      const cursor = page['more'] as string;
      assert.equal(page['truncated'], true);
      assert.equal(typeof cursor, 'string');
      assert.ok(cursor.length > 1, 'a cursor to follow');
      const changed = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;

      const plans: Plan[] = [
        { cli: [...base, '--budget', '40'], tool: 'code_find', args: { name: 'parse', mode: 'prefix', budget_tokens: 40, repo: fixture.dir } },
        { cli: [...base, '--budget', '40', '--more', cursor], tool: 'code_find', args: { name: 'parse', mode: 'prefix', budget_tokens: 40, more: cursor, repo: fixture.dir } },
        { cli: [...base, '--budget', '40', '--more', changed], tool: 'code_find', args: { name: 'parse', mode: 'prefix', budget_tokens: 40, more: changed, repo: fixture.dir } },
      ];
      const [one, two, bad] = await askBoth(fixture, plans);
      assert.equal(one?.envelope['truncated'], true);
      assert.equal(one.envelope['more'], cursor, 'the same cursor on both surfaces');
      assert.equal(two?.code, 0);
      assert.deepEqual(rowsOf(two.envelope).map((row) => row.name), ['parseLine'], 'the second page holds the rest');
      assert.notDeepEqual(rowsOf(one.envelope).map((row) => row.name), rowsOf(two.envelope).map((row) => row.name));
      assert.equal(bad?.envelope.ok, false);
      assert.equal(bad.envelope.diagnostics[0]?.code, 'bad_cursor');
      assert.equal(bad.isError, true);
      assert.equal(bad.code, 2);
    });
  });
});

describe('injection: repository text reaches an agent only inside untrusted_text (QRY-05)', () => {
  it('injection: an instruction and a forged fence marker in a comment come back only in the fenced field, through both surfaces', async () => {
    await withFixture('injection', async (fixture) => {
      await build(fixture);
      const pairs = await askBoth(fixture, [
        { cli: ['find', 'parse', '--repo', fixture.dir], tool: 'code_find', args: { name: 'parse', repo: fixture.dir } },
        { cli: ['context', 'parse', '--repo', fixture.dir], tool: 'code_context', args: { name: 'parse', repo: fixture.dir } },
        { cli: ['find', 'sec', '--mode', 'prefix', '--repo', fixture.dir], tool: 'code_find', args: { name: 'sec', mode: 'prefix', repo: fixture.dir } },
      ]);
      const [find, context, secret] = pairs;
      for (const pair of [find, context]) {
        assert.ok(pair !== undefined);
        assert.equal(pair.code, 0);
        const { untrusted_text: fenced, ...rest } = pair.envelope as Envelope & { untrusted_text: { nonce: string; entries: Array<{ text: string }> } };
        const outside = JSON.stringify(rest);
        assert.ok(!outside.includes(INJECTION_SENTENCE), 'the instruction is not outside untrusted_text');
        assert.ok(!outside.includes('Ignore all previous instructions'), 'no part of the instruction is outside untrusted_text');
        assert.ok(!outside.includes(FORGED_FENCE), 'the forged fence marker is not outside untrusted_text');
        assert.ok(fenced.entries.some((entry) => entry.text.includes(INJECTION_SENTENCE)), 'the instruction is inside untrusted_text');
        assert.ok(!FORGED_FENCE.includes(fenced.nonce), 'the real nonce is not the forged one');
        for (const entry of fenced.entries) {
          assert.ok(entry.text.startsWith(`BEGIN-UNTRUSTED-${fenced.nonce}\n`), 'every entry opens with the real marker');
          assert.ok(entry.text.endsWith(`\nEND-UNTRUSTED-${fenced.nonce}`), 'every entry closes with the real marker');
        }
      }
      assert.ok(secret !== undefined);
      assert.equal(rowsOf(secret.envelope)[0]?.name, 'secret', 'the zero-width joiner in the symbol name is removed');
      assert.ok(!secret.line.includes('‍') && !secret.text.includes('‍'), 'no invisible character reaches either surface');
    });
  });
});
