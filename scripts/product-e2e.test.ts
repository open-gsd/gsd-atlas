/**
 * The product as users run it, with real processes (HST-01, HST-02, IDX-01, STO-08; plan 02-25): the `gsd-atlas` and
 * `gsd-atlas-mcp` bins started through the CommandRunner against real temporary git repositories, with the real
 * watcher in the leader. These cases also prove the packaging seams (the bins start, load their grammars and workers
 * and find their files) on every operating system in CI.
 *
 * Time: no case asserts a latency except the save-to-find case, which compares with the approved PR ceiling. Every
 * other wait is a polling loop (25 ms) bounded by a ceiling that only turns a hung child into a failed test, never a
 * fixed sleep. A failing case prints the stderr of every process it ran (see `withFixture`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { maskNonce, withFixture } from './test-helpers/fixture-repo.ts';
import type { CliRun, FixtureRepo } from './test-helpers/fixture-repo.ts';
import type { Envelope, McpClient } from './test-helpers/mcp-client.ts';
import { EXIT_CEILING_MS } from './test-helpers/mcp-process.ts';

/**
 * The approved CI ceiling for save-to-find: gate.freshnessPrCeilingMs in
 * .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md (Status: Approved, 2026-10-16). The nightly
 * p99 of 1,000 ms is checked elsewhere (plan 02-26); a hosted runner on a PR gets this looser bound.
 */
const FRESHNESS_PR_CEILING_MS = 3000;

/** How often a polling loop asks again. */
const POLL_MS = 25;

/**
 * The bound of every other polling wait (readiness, a branch switch seen by the watcher): the hung-child ceiling the
 * stdio tests of plan 02-23 already use. It is not a latency expectation.
 */
const WAIT_CEILING_MS = EXIT_CEILING_MS;

interface Row {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly [key: string]: unknown;
}

const rowsOf = (envelope: Envelope): Row[] => (envelope.data as { results: Row[] }).results;

const envelopeOf = (run: CliRun): Envelope => {
  assert.ok(run.stdout.endsWith('\n') && run.stdout.indexOf('\n') === run.stdout.length - 1, `stdout must be one JSON line, got ${JSON.stringify(run.stdout)}`);
  return JSON.parse(run.stdout) as Envelope;
};

async function build(fixture: FixtureRepo, args: readonly string[] = ['--repo', fixture.dir]): Promise<void> {
  const built = await fixture.cli(['build', ...args]);
  assert.equal(built.code, 0, built.stderr);
}

/** Ask `ask` every 25 ms until `accept` approves its answer; fail after `ceilingMs`. Resolves to the answer and the time it took. */
async function pollFor<T>(ceilingMs: number, what: string, ask: () => Promise<T>, accept: (answer: T) => boolean): Promise<{ answer: T; elapsedMs: number }> {
  const started = performance.now();
  for (;;) {
    const answer = await ask();
    const elapsedMs = performance.now() - started;
    if (accept(answer)) return { answer, elapsedMs };
    if (elapsedMs > ceilingMs) assert.fail(`${what} within ${String(ceilingMs)} ms; the last answer was ${JSON.stringify(answer)}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}

const find = async (server: McpClient, args: Record<string, unknown>): Promise<Envelope> => (await server.callTool('code_find', args)).envelope;

/** The state of the first worktree in `atlas_status`: its watermark sequence number. */
async function statusSeq(server: McpClient, repo: string): Promise<number> {
  const status = (await server.callTool('atlas_status', { repo })).envelope;
  const worktrees = (status.data as { worktrees: Array<{ worktree: string; seq: number }> }).worktrees;
  return worktrees.find((entry) => path.resolve(entry.worktree) === path.resolve(repo))?.seq ?? Number.NaN;
}

/** Let the server finish the start-up Reconcile its first call kicked off, so a later save is seen by a watcher that runs. */
async function untilSettled(server: McpClient, repo: string): Promise<void> {
  await pollFor(
    WAIT_CEILING_MS,
    'the start-up Reconcile to finish',
    async () => (await server.callTool('atlas_status', { repo })).envelope,
    (status) => {
      const indexer = (status.data as { indexer: { reconciling: boolean; lastReconcileAt: number | null } }).indexer;
      return !indexer.reconciling && indexer.lastReconcileAt !== null;
    },
  );
}

/** The envelope without `degraded` and with the nonce masked, as one string: what two roles must agree on. */
function withoutDegraded(text: string): string {
  const envelope = JSON.parse(maskNonce(text)) as Record<string, unknown>;
  delete envelope['degraded'];
  return JSON.stringify(envelope);
}

describe('two sessions on one repository (STO-08, HST-01)', () => {
  it('follower: while the server leads, a CLI find answers degraded follower with otherwise equal data; build and maintain exit 3; after the server ends, build succeeds', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const server = fixture.mcp();
      await server.initialize();
      // The first call opens the tenant: the server takes the writer lease and starts its watcher.
      const lead = await server.callTool('code_find', { name: 'parse', repo: fixture.dir });
      assert.equal(lead.envelope.ok, true);
      assert.ok(!(lead.envelope.degraded ?? []).includes('follower'), `the leader is not a follower: ${JSON.stringify(lead.envelope.degraded)}`);

      const follow = await fixture.cli(['find', 'parse', '--repo', fixture.dir]);
      assert.equal(follow.code, 0, follow.stderr);
      const followed = envelopeOf(follow);
      assert.ok(followed.degraded?.includes('follower'), `degraded names follower, got ${JSON.stringify(followed.degraded)}`);

      // The one difference, asserted by name: the follower's degraded list is the leader's plus 'follower'.
      assert.deepEqual([...(followed.degraded ?? [])].sort(), [...(lead.envelope.degraded ?? []), 'follower'].sort());
      // Everything else (data, citations, watermark, fenced text) is byte for byte the leader's answer.
      assert.equal(withoutDegraded(follow.stdout), withoutDegraded(lead.result.content[0]?.text ?? ''));
      assert.equal(rowsOf(followed)[0]?.path, 'a.ts');

      for (const args of [['build'], ['maintain'], ['maintain', 'collect']]) {
        const refused = await fixture.cli([...args, '--repo', fixture.dir]);
        assert.equal(refused.code, 3, `${args.join(' ')} exit 3 while the server leads: ${refused.stderr}`);
        const envelope = envelopeOf(refused);
        assert.equal(envelope.ok, false);
        assert.equal(envelope.diagnostics[0]?.code, 'lease_held');
      }

      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
      // The operating system released the lease with the process: a new build is the leader.
      const rebuilt = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(rebuilt.code, 0, rebuilt.stderr);
    });
  });

  it('exit 3 and SIGKILL takeover: when the leading server is killed, the lease is released by the operating system, build succeeds, and a later server leads again', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const first = fixture.mcp();
      await first.initialize();
      assert.equal((await find(first, { name: 'parse', repo: fixture.dir })).ok, true);
      const blocked = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(blocked.code, 3, 'the live leader holds the lease');

      first.kill();
      await first.exit();

      const rebuilt = await fixture.cli(['build', '--repo', fixture.dir]);
      assert.equal(rebuilt.code, 0, rebuilt.stderr);

      const second = fixture.mcp();
      await second.initialize();
      const answer = await find(second, { name: 'parse', repo: fixture.dir });
      assert.equal(answer.ok, true);
      assert.ok(!(answer.degraded ?? []).includes('follower'), `the new server leads: ${JSON.stringify(answer.degraded)}`);
      const status = (await second.callTool('atlas_status', { repo: fixture.dir })).envelope;
      assert.equal((status.data as { store: { writerLeaseHeld: boolean } }).store.writerLeaseHeld, true);
      assert.equal((await fixture.cli(['build', '--repo', fixture.dir])).code, 3, 'and it holds the lease against a new build');
      await second.close();
    });
  });
});

describe('freshness through the server (IDX-01)', () => {
  it('freshness: a save reaches code_find without a fresh argument within the approved CI ceiling, and the elapsed time is printed', async (t: TestContext) => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const server = fixture.mcp();
      await server.initialize();
      assert.equal((await find(server, { name: 'parse', repo: fixture.dir })).ok, true);
      await untilSettled(server, fixture.dir);

      const source = fs.readFileSync(path.join(fixture.dir, 'a.ts'), 'utf8');
      fixture.repo.write('a.ts', `${source}export function freshlySaved(): number {\n  return 3;\n}\n`);
      const saved = performance.now();
      const { answer, elapsedMs } = await pollFor(
        FRESHNESS_PR_CEILING_MS,
        'a saved definition to reach code_find',
        () => find(server, { name: 'freshlySaved', repo: fixture.dir }),
        (envelope) => envelope.ok && rowsOf(envelope).some((row) => row.path === 'a.ts'),
      );
      const sinceSave = performance.now() - saved;
      t.diagnostic(`save to find: ${sinceSave.toFixed(0)} ms (poll loop ${elapsedMs.toFixed(0)} ms), ceiling gate.freshnessPrCeilingMs ${String(FRESHNESS_PR_CEILING_MS)} ms`);
      process.stdout.write(`# save to find through the MCP server: ${sinceSave.toFixed(0)} ms (approved CI ceiling ${String(FRESHNESS_PR_CEILING_MS)} ms)\n`);
      assert.equal(rowsOf(answer)[0]?.line, 4);
      assert.ok(sinceSave <= FRESHNESS_PR_CEILING_MS, `save to find took ${sinceSave.toFixed(0)} ms, above the approved ceiling ${String(FRESHNESS_PR_CEILING_MS)} ms`);
      await server.close();
    });
  });

  it('fresh argument: a second edit named in fresh is returned by the very first call, and saving identical content changes nothing', async () => {
    await withFixture('ts-three-files', async (fixture) => {
      await build(fixture);
      const server = fixture.mcp();
      await server.initialize();
      assert.equal((await find(server, { name: 'parse', repo: fixture.dir })).ok, true);
      await untilSettled(server, fixture.dir);

      const source = fs.readFileSync(path.join(fixture.dir, 'a.ts'), 'utf8');
      const edited = `${source}export function namedByFresh(): number {\n  return 4;\n}\n`;
      const beforeEdit = await statusSeq(server, fixture.dir);
      fixture.repo.write('a.ts', edited);
      // Read your own writes: naming the path makes the very first call fresh, with no waiting.
      const named = await find(server, { name: 'namedByFresh', repo: fixture.dir, fresh: ['a.ts'] });
      assert.equal(named.ok, true, JSON.stringify(named.diagnostics));
      assert.equal(rowsOf(named)[0]?.path, 'a.ts', 'the first call with fresh returns the edit');
      assert.equal(rowsOf(named)[0]?.line, 4);

      // Saving the same bytes again is not a change: the watermark does not move.
      const before = await statusSeq(server, fixture.dir);
      assert.ok(Number.isInteger(before), `the watermark sequence of ${fixture.dir} is a number`);
      assert.ok(before > beforeEdit, `a real edit moves the watermark (${String(beforeEdit)} to ${String(before)}), so the identical save below is a meaningful comparison`);
      fixture.repo.write('a.ts', edited);
      const again = await find(server, { name: 'namedByFresh', repo: fixture.dir, fresh: ['a.ts'] });
      assert.equal(again.ok, true);
      assert.equal(await statusSeq(server, fixture.dir), before, 'an identical save leaves the watermark where it was');
      await server.close();
    });
  });
});

describe('worktrees and repositories (HST-02)', () => {
  it('worktrees: each worktree answers with its own branch, the shared parse serves both, and the watcher follows a checkout', async () => {
    await withFixture('worktrees', async (fixture) => {
      const main = fixture.dir;
      const feature = fixture.featureDir as string;
      assert.ok(feature !== undefined && fs.existsSync(path.join(feature, 'src', 'b', 'index.ts')));

      const mainBuilt = envelopeOf(await fixture.cli(['build', '--cwd', main]));
      assert.equal((mainBuilt.data as { parsed: number }).parsed, 2);
      const featureBuilt = envelopeOf(await fixture.cli(['build', '--cwd', feature]));
      assert.equal((featureBuilt.data as { parsed: number; linked: number }).parsed, 0, 'every blob of the feature worktree was already parsed for main');
      assert.equal((featureBuilt.data as { linked: number }).linked, 2);

      const mainFind = await fixture.cli(['find', 'run', '--cwd', main]);
      const featureFind = await fixture.cli(['find', 'run', '--cwd', feature]);
      assert.equal(mainFind.code, 0, mainFind.stderr);
      assert.equal(featureFind.code, 0, featureFind.stderr);
      assert.deepEqual(rowsOf(envelopeOf(mainFind)).map((row) => row.path), ['src/b.ts']);
      assert.deepEqual(rowsOf(envelopeOf(featureFind)).map((row) => row.path), ['src/b/index.ts']);

      const mainRefs = envelopeOf(await fixture.cli(['refs', 'run', '--cwd', main]));
      const featureRefs = envelopeOf(await fixture.cli(['refs', 'run', '--cwd', feature]));
      const callSite = (envelope: Envelope): string[] => rowsOf(envelope).map((row) => `${row.path}:${String(row.line)}:${String(row['col'])}:${String(row['enclosing'])}`);
      assert.deepEqual(callSite(mainRefs), ['src/main.ts:3:10:main']);
      assert.deepEqual(callSite(featureRefs), ['src/main.ts:3:10:main'], 'the same call site on both branches');
      const handleOf = (envelope: Envelope): unknown => (envelope['citations'] as Array<{ debug: string }>)[0]?.debug;
      assert.equal(handleOf(mainRefs), handleOf(featureRefs), 'the reference comes from one shared parse of src/main.ts');

      // A checkout in the feature worktree, seen by the leader's watcher: the answer becomes main's.
      const server = fixture.mcp();
      await server.initialize();
      const before = await find(server, { name: 'run', repo: feature });
      assert.deepEqual(rowsOf(before).map((row) => row.path), ['src/b/index.ts']);
      await untilSettled(server, feature);
      await fixture.git(['checkout', '--quiet', '--detach', 'main'], feature);
      assert.ok(fs.existsSync(path.join(feature, 'src', 'b.ts')) && !fs.existsSync(path.join(feature, 'src', 'b', 'index.ts')));
      const { answer } = await pollFor(
        WAIT_CEILING_MS,
        'the watcher to follow the checkout in the feature worktree',
        () => find(server, { name: 'run', repo: feature }),
        (envelope) => envelope.ok && rowsOf(envelope).some((row) => row.path === 'src/b.ts'),
      );
      assert.deepEqual(rowsOf(answer).map((row) => row.path), ['src/b.ts']);
      // The main worktree is untouched by the feature worktree's checkout.
      assert.deepEqual(rowsOf(await find(server, { name: 'run', repo: main })).map((row) => row.path), ['src/b.ts']);
      await server.close();
    });
  });

  it('two repositories: one server process keeps the answers of unrelated repositories apart, each with its own store under its own git directory', async () => {
    await withFixture('two-repos', async (fixture) => {
      const other = (fixture.second as NonNullable<typeof fixture.second>).dir;
      await build(fixture, ['--repo', fixture.dir]);
      await build(fixture, ['--repo', other]);

      const server = fixture.mcp();
      await server.initialize();
      const ask = async (name: string, repo: string): Promise<string[]> => {
        const envelope = await find(server, { name, repo, mode: 'exact' });
        assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
        return rowsOf(envelope).map((row) => row.path);
      };
      assert.deepEqual(await ask('parse', fixture.dir), ['a.ts']);
      assert.deepEqual(await ask('elsewhere', other), ['other.ts']);
      assert.deepEqual(await ask('elsewhere', fixture.dir), [], 'a symbol of the other repository is not found here');
      assert.deepEqual(await ask('parse', other), [], 'and the other way round');
      // Neither repository's server state got in the other's way: both keep answering.
      assert.deepEqual(await ask('load', fixture.dir), ['b.ts']);
      assert.deepEqual(await ask('useIt', other), ['user.ts']);

      const storeOf = (repo: string): string => path.join(repo, '.git', 'gsd-atlas');
      assert.ok(fs.existsSync(storeOf(fixture.dir)), 'the first repository has a store in its git directory');
      assert.ok(fs.existsSync(storeOf(other)), 'the second repository has a store in its git directory');
      assert.notEqual(fs.realpathSync(storeOf(fixture.dir)), fs.realpathSync(storeOf(other)));
      const exit = await server.close();
      assert.equal(exit.exitCode, 0, server.stderrText());
    });
  });
});
