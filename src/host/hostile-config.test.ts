/**
 * SEC-01 acceptance test: committed repository content can never enable a command.
 *
 * Criterion (ROADMAP, Phase 3 goal text and the trust-boundaries ADR amendment of plan 03-08): a repository may carry
 * a module manifest with `precise.command`, a `.gsd-atlas/config.json` naming permissions, diagnostics and commands, a
 * `package.json` with install scripts and a `tsconfig.json` with a compiler plugin, and none of it starts a process.
 * The only processes the Host starts for such a repository are the first-party built-in git specs, through a full
 * `build`, `maintain all` and every code tool, and the marker file the hostile commands would write never appears.
 *
 * This test protects behavior that already holds. Plans 03-15 and 03-29 (the precise tier and the first real
 * `precise.command` run) must keep it green; if a change makes it fail, the change is wrong, not the test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { createRealRunner, createRecordingRunner, decide } from '../command-runner/index.ts';
import type { CommandSpec, Decision, RecordedSpec, RunContext, UserPermissions } from '../command-runner/index.ts';
import type { Envelope } from '../facts/index.ts';
import { THREE_FILES, makeWorld } from './harness.test.ts';
import type { World } from './harness.test.ts';

const MARKER = 'PWNED';

/** Writes the marker next to the repository root, wherever the script sits below `.gsd-atlas/languages/evil`. */
const WRITE_MARKER_FROM_MODULE =
  "require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', '..', '..', 'PWNED'), 'pwned');\n";
const WRITE_MARKER_FROM_ROOT = "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'PWNED'), 'pwned');\n";

/** The hostile repository, as strings: nothing here is a committed fixture folder. */
const HOSTILE_FILES: Readonly<Record<string, string>> = {
  ...THREE_FILES,
  'thing.evil': 'evil thing\n',
  'src/a.ts': 'export function helperTs(): number {\n  return 1;\n}\n',
  'src/b.ts': "import { helperTs } from './a.ts';\nexport const value = helperTs();\n",
  '.gsd-atlas/languages/evil/atlas-lang.json': JSON.stringify({
    schemaVersion: 1,
    name: 'evil',
    version: '0.1.0',
    extensions: ['.evil'],
    grammar: { wasm: 'grammar.wasm', lock: 'grammar.lock' },
    queries: { tags: 'queries/tags.scm' },
    tiers: ['grammar', 'precise'],
    precise: { command: ['node', 'evil.js'] },
  }),
  '.gsd-atlas/languages/evil/evil.js': WRITE_MARKER_FROM_MODULE,
  '.gsd-atlas/config.json': JSON.stringify({
    permissions: { allow: [{ executable: 'node' }, { executable: process.execPath }], commands: ['node', process.execPath] },
    diagnostics: { enabled: true },
    autoSubmit: true,
    commands: [{ executable: 'node', args: ['mark.js'] }],
    // Plan 03-28: the one key the repository config is read for. These name directories outside the repository (a `..` path,
    // a sibling directory, and a link that points at it): none of them may list anything.
    adrDirs: ['../../etc', '../outside-adr', 'linked-adr'],
  }),
  'mark.js': WRITE_MARKER_FROM_ROOT,
  'package.json': JSON.stringify({
    name: 'hostile',
    version: '1.0.0',
    scripts: { preinstall: 'node mark.js', postinstall: 'node mark.js', prepare: 'node mark.js', test: 'node mark.js' },
  }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { plugins: [{ name: './mark.js' }] } }),
};

/** One start request as the Host's runner saw it, with the rule's decision. */
interface Attempt {
  readonly spec: CommandSpec;
  readonly decision: Decision;
}

/** A user config that allows `node` for a different repository only. */
function otherRepoPermissions(): UserPermissions {
  const other = path.resolve(os.tmpdir(), 'ga-some-other-repository');
  return { allow: [{ repo: other, executable: 'node' }, { repo: other, executable: process.execPath }] };
}

interface Outcome {
  readonly world: World;
  readonly attempts: readonly Attempt[];
  readonly started: readonly RecordedSpec[];
  readonly replies: Readonly<Record<string, Envelope>>;
}

/** Compose a Host over the hostile repository, run the whole read-and-build surface, and report what was started. */
async function runHostile(t: TestContext, user: UserPermissions | undefined): Promise<Outcome> {
  const attempts: Attempt[] = [];
  const rule = (spec: CommandSpec, ctx: RunContext): Decision => {
    const decision = decide(spec, ctx, user);
    attempts.push({ spec, decision });
    return decision;
  };
  const runner = createRecordingRunner({ decide: rule, delegate: createRealRunner({ ...(user === undefined ? {} : { user }) }) });
  const world = await makeWorld(t, {
    files: HOSTILE_FILES,
    host: { runner, ...(user === undefined ? {} : { config: { permissions: user } }) },
  });
  const repo = world.repo.dir;
  // A document outside the repository, reachable by a `..` path, as a sibling and through a link inside the repository.
  const outside = path.join(path.dirname(repo), 'outside-adr');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, '0001-outside.md'), 'outside\n');
  try {
    fs.symlinkSync(outside, path.join(repo, 'linked-adr'), 'dir');
  } catch {
    // creating a link needs privileges on Windows; the `..` and sibling forms are still checked
  }
  const replies: Record<string, Envelope> = {};
  const ask = async (label: string, kind: string, args: Record<string, unknown>): Promise<void> => {
    replies[label] = await world.ask(kind, args);
  };
  await ask('build', 'build', { repo });
  await ask('maintain', 'maintain', { repo, task: 'all' });
  await ask('code_find', 'code_find', { name: 'helper', repo });
  await ask('code_refs', 'code_refs', { name: 'boot', repo });
  await ask('code_context', 'code_context', { name: 'helper', repo });
  await ask('code_impact', 'code_impact', { name: 'boot', repo });
  await ask('atlas_status', 'atlas_status', { repo });
  await ask('lang_list', 'lang_list', { repo });
  await ask('adr_refs', 'code_refs', { name: 'ADR-1', kind: 'adr', repo });
  await ask('adr_find', 'code_find', { name: 'ADR-1', kind: 'adr', repo });
  return { world, attempts, started: runner.starts, replies };
}

function assertNothingButBuiltinGit(outcome: Outcome): void {
  assert.ok(outcome.attempts.length > 0, 'the Host did run git, so the recording is live');
  for (const { spec, decision } of outcome.attempts) {
    assert.equal(spec.executable, 'git', `a spec for ${spec.executable} was attempted, not merely denied`);
    assert.equal(decision.allowed, true, `git spec denied: ${spec.args.join(' ')}`);
    assert.equal(decision.allowed && decision.via, 'builtin', 'every start is a first-party built-in');
  }
  assert.ok(outcome.started.every((spec) => spec.executable === 'git'));
}

function assertNoMarker(outcome: Outcome): void {
  const repo = outcome.world.repo.dir;
  for (const where of [repo, path.join(repo, '.gsd-atlas'), path.join(repo, '.gsd-atlas', 'languages', 'evil'), path.join(repo, 'src')]) {
    assert.equal(fs.existsSync(path.join(where, MARKER)), false, `${MARKER} appeared in ${where}`);
  }
}

describe('SEC-01: a hostile repository runs nothing', () => {
  it('no process but built-in git, through build, maintain all and the code tools', async (t) => {
    const outcome = await runHostile(t, undefined);
    assertNothingButBuiltinGit(outcome);
    assert.equal(outcome.replies['build']?.ok, true, JSON.stringify(outcome.replies['build']?.diagnostics));
    for (const label of ['maintain', 'code_find', 'code_refs', 'code_context', 'code_impact', 'atlas_status']) {
      const reply = outcome.replies[label];
      assert.ok(reply !== undefined, label);
      assert.equal(typeof reply.ok, 'boolean', `${label} answered with an envelope`);
    }
    assert.equal(outcome.replies['code_find']?.ok, true, JSON.stringify(outcome.replies['code_find']?.diagnostics));
  });

  it('marker file absent', async (t) => {
    const outcome = await runHostile(t, undefined);
    assertNoMarker(outcome);
  });

  it('lang_list reports needs approval', async (t) => {
    const outcome = await runHostile(t, undefined);
    const reply = outcome.replies['lang_list'];
    assert.equal(reply?.ok, true, JSON.stringify(reply?.diagnostics));
    const modules = (reply?.data as { modules: ReadonlyArray<{ name: string; source: string; tiers: ReadonlyArray<{ tier: string; active: boolean; reason?: string }> }> }).modules;
    const evil = modules.find((m) => m.name === 'evil');
    assert.ok(evil !== undefined, 'the repository module is listed');
    assert.equal(evil.source, 'repo');
    const precise = evil.tiers.find((tier) => tier.tier === 'precise');
    assert.equal(precise?.active, false, 'the precise tier is not active');
    assert.equal(precise?.reason, 'command_not_approved');
    const note = reply?.diagnostics.find((d) => d.code === 'precise_command_inactive');
    assert.match(note?.message ?? '', /user-level config approves it/);
    assertNothingButBuiltinGit(outcome);
  });

  it("other repo's permission does not apply", async (t) => {
    const outcome = await runHostile(t, otherRepoPermissions());
    assertNothingButBuiltinGit(outcome);
    assertNoMarker(outcome);
    assert.equal(outcome.replies['build']?.ok, true, JSON.stringify(outcome.replies['build']?.diagnostics));
    const modules = (outcome.replies['lang_list']?.data as { modules: ReadonlyArray<{ name: string; tiers: ReadonlyArray<{ tier: string; active: boolean }> }> }).modules;
    const precise = modules.find((m) => m.name === 'evil')?.tiers.find((tier) => tier.tier === 'precise');
    assert.equal(precise?.active, false);
  });

  it('adrDirs of the repository config lists nothing outside the repository and the other keys enable nothing', async (t) => {
    const outcome = await runHostile(t, undefined);
    for (const label of ['adr_refs', 'adr_find']) {
      const reply = outcome.replies[label];
      assert.equal(reply?.ok, true, `${label}: ${JSON.stringify(reply?.diagnostics)}`);
      const data = reply?.data as { adr?: { status: string; files: string[] }; status?: string };
      assert.equal(data.adr?.status ?? data.status, 'unresolved', `${label}: the outside document was not found`);
      assert.deepEqual(data.adr?.files ?? [], [], `${label}: nothing was listed`);
      assert.ok(!JSON.stringify(reply).includes('0001-outside'), `${label}: the outside document is never named`);
      const notes = reply?.diagnostics.filter((d) => d.code === 'repo_config_ignored') ?? [];
      assert.equal(notes.length, 1, `${label}: one fixed diagnostic for the ignored keys and entries`);
      assert.equal(notes[0]?.severity, 'info');
    }
    assertNothingButBuiltinGit(outcome);
    assertNoMarker(outcome);
  });

  it('decide denies directly', async (t) => {
    const world = await makeWorld(t, { files: HOSTILE_FILES });
    const repo = world.repo.dir;
    const specs: readonly CommandSpec[] = [
      { executable: 'node', args: ['evil.js'], cwd: repo },
      { executable: process.execPath, args: ['mark.js'], cwd: repo },
      { executable: 'node', args: ['.gsd-atlas/languages/evil/evil.js'] },
    ];
    for (const spec of specs) {
      const bare = decide(spec, { repo });
      assert.equal(bare.allowed, false, `${spec.executable} ${spec.args.join(' ')}`);
      assert.equal(!bare.allowed && bare.diagnostic.code, 'command_denied');
      // User permissions for another repository do not reach this one.
      const elsewhere = decide(spec, { repo }, otherRepoPermissions());
      assert.equal(elsewhere.allowed, false);
      assert.equal(!elsewhere.allowed && elsewhere.diagnostic.code, 'command_denied');
      // Nothing in the spec or the context can grant permission either.
      assert.equal(decide({ ...spec, permissions: { commands: ['node'] } } as CommandSpec, { repo, permissions: { commands: ['node'] } } as RunContext).allowed, false);
    }
  });
});
