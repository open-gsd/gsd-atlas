/**
 * The walking skeleton at the CLI layer (ROADMAP Planning Notes): `runCli` over the real composed Host (real runner,
 * pooled Grammar Engine, Governor, Tenant, store and Query) in a temporary git repository. Each command prints one
 * JSON envelope on stdout, so every stdout line below is parsed with JSON.parse.
 *
 * It lives under scripts because the adapter lint forbids src/cli tests from importing any module but host-client.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { composeHost } from '../src/bin/compose.ts';
import type { Composed } from '../src/bin/compose.ts';
import { runCli } from '../src/cli/index.ts';
import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { createTempGitRepo, makeTempDir } from '../src/test-kit/index.ts';
import type { TempDir, TempGitRepo } from '../src/test-kit/index.ts';

const toyModule = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'modules', 'toy');
const setupRunner = createRealRunner({ decide: allowAll });

const THREE_FILES: Readonly<Record<string, string>> = {
  'a.toy': 'fn main {\n  boot();\n}\nfn boot {\n}\n',
  'b.toy': 'fn helper {\n}\n',
  'c.toy': 'type Widget {\n}\n',
  'README.md': '# toy repository\n',
};

/** What one CLI run printed. */
export interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The stdout parsed as exactly one JSON line. */
  readonly envelope: Envelope;
}

export interface Envelope {
  readonly schema: string;
  readonly ok: boolean;
  readonly data: unknown;
  readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly severity: string; readonly message: string }>;
  readonly degraded?: readonly string[];
  readonly [key: string]: unknown;
}

export interface World {
  readonly repo: TempGitRepo;
  readonly tmp: TempDir;
  readonly composed: Composed;
  /** Run one CLI command over this world's Host. The CLI's working directory is the parent of the repository. */
  cli(argv: readonly string[]): Promise<Run>;
  /** Another process over the same repository: a second composed Host (the follower when the first holds the lease). */
  another(): Composed;
}

export interface WorldOptions {
  readonly files?: Readonly<Record<string, string>>;
}

function sink(): { readonly text: () => string; write(text: string): boolean } {
  const written: string[] = [];
  return {
    text: () => written.join(''),
    write: (text) => {
      written.push(text);
      return true;
    },
  };
}

/** A real temporary repository, the toy language module as a user module, and a composed Host over them. */
export async function makeWorld(t: TestContext, options: WorldOptions = {}): Promise<World> {
  const tmp = makeTempDir();
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: options.files ?? THREE_FILES } });
  const userDir = path.join(tmp.path, 'user');
  fs.cpSync(toyModule, path.join(userDir, 'languages', 'toy'), { recursive: true });
  const env = { ...process.env, ...repo.envOverlay, GSD_ATLAS_USER_DIR: userDir };
  const hosts: Composed[] = [];
  const compose = (): Composed => {
    const composed = composeHost({ cwd: tmp.path, env, home: path.join(tmp.path, 'home'), stderr: sink() });
    hosts.push(composed);
    return composed;
  };
  const composed = compose();
  t.after(async () => {
    for (const each of hosts) await each.dispose();
    tmp.cleanup();
    repo.cleanup();
  });
  const cwd = path.dirname(repo.dir);
  return {
    repo,
    tmp,
    composed,
    another: compose,
    cli: (argv) => runWith(composed, argv, cwd),
  };
}

/** Run the CLI once over `composed` and parse what it printed. */
export async function runWith(composed: Composed, argv: readonly string[], cwd: string): Promise<Run> {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(argv, { client: composed.client, version: () => '0.0.0', stdout, stderr, cwd });
  const out = stdout.text();
  assert.ok(out === '' || (out.endsWith('\n') && out.indexOf('\n') === out.length - 1), `stdout must be one JSON line, got ${JSON.stringify(out)}`);
  return { code, stdout: out, stderr: stderr.text(), envelope: out === '' ? ({} as Envelope) : (JSON.parse(out) as Envelope) };
}

describe('CLI walking skeleton: build, then find', () => {
  it('build exits 0 with one build envelope, find then prints the definition with its citation and fenced text, and stderr stays empty', async (t) => {
    const world = await makeWorld(t);
    const built = await world.cli(['build', '--repo', world.repo.dir]);
    assert.equal(built.code, 0, built.stderr);
    assert.equal(built.envelope.schema, 'gsd-atlas.build/1');
    assert.equal(built.envelope.ok, true);
    assert.equal((built.envelope.data as { files: number }).files, 3);
    assert.equal(built.stderr, '');

    const found = await world.cli(['find', 'helper', '--repo', world.repo.dir]);
    assert.equal(found.code, 0, found.stderr);
    assert.equal(found.envelope.schema, 'gsd-atlas.code-find/1');
    const results = (found.envelope.data as { results: Array<{ name: string; path: string; line: number; citation: string }> }).results;
    assert.equal(results[0]?.name, 'helper');
    assert.equal(results[0]?.path, 'b.toy');
    assert.equal(results[0]?.line, 1);
    const citations = found.envelope['citations'] as Array<{ id: string; path: string }>;
    assert.ok(citations.some((citation) => citation.id === results[0]?.citation && citation.path === 'b.toy'), 'the result is cited');
    const fenced = found.envelope['untrusted_text'] as { nonce: string; entries: Array<{ text: string }> };
    assert.ok(fenced.entries.some((entry) => entry.text.includes('fn helper')), 'the matched line is in the fenced field');
    assert.equal(found.stderr, '');
  });

  it('find before build exits 2 with the not_indexed envelope on stdout and a reason naming gsd-atlas build on stderr', async (t) => {
    const world = await makeWorld(t);
    const found = await world.cli(['find', 'helper', '--repo', world.repo.dir]);
    assert.equal(found.code, 2);
    assert.equal(found.envelope.ok, false);
    assert.equal(found.envelope.diagnostics[0]?.code, 'not_indexed');
    assert.match(found.stderr, /gsd-atlas build/);
    assert.equal(found.stderr.split('\n').filter((line) => line !== '').length, 1, 'one reason line');
  });

  it('a relative --repo is resolved against the CLI working directory, and a directory that is not a repository exits 2 with not_a_repo', async (t) => {
    const world = await makeWorld(t);
    const built = await world.cli(['build', '--repo', path.basename(world.repo.dir)]);
    assert.equal(built.code, 0, built.stderr);
    const missing = await world.cli(['find', 'x', '--repo', 'no-such-directory']);
    assert.equal(missing.code, 2);
    assert.equal(missing.envelope.diagnostics[0]?.code, 'not_a_repo');
  });

  it('usage errors never reach the Host: find without a name exits 1 with nothing on stdout', async (t) => {
    const world = await makeWorld(t);
    const bad = await world.cli(['find']);
    assert.equal(bad.code, 1);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /Usage: gsd-atlas/);
  });
});
