import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { PROTOCOL_VERSION } from '../facts/index.ts';
import { createTempGitRepo, makeTempDir } from '../test-kit/index.ts';
import { composeHost } from './compose.ts';

const toyModule = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');
const setupRunner = createRealRunner({ decide: allowAll });

interface Sink {
  readonly written: string[];
  write(text: string): boolean;
}

const sink = (): Sink => {
  const written: string[] = [];
  return {
    written,
    write: (text) => {
      written.push(text);
      return true;
    },
  };
};

describe('composeHost', () => {
  it('returns a working client for a working directory and a user directory, and dispose closes everything', async (t) => {
    const tmp = makeTempDir();
    const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: { 'b.toy': 'fn helper {\n}\n' } } });
    t.after(() => {
      tmp.cleanup();
      repo.cleanup();
    });
    const userDir = path.join(tmp.path, 'user');
    fs.cpSync(toyModule, path.join(userDir, 'languages', 'toy'), { recursive: true });
    const stderr = sink();
    const composed = composeHost({
      cwd: repo.dir,
      env: { ...process.env, ...repo.envOverlay, GSD_ATLAS_USER_DIR: userDir },
      home: path.join(tmp.path, 'home'),
      stderr,
    });
    t.after(async () => {
      await composed.dispose();
    });

    const listed = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list' });
    assert.equal(listed.ok, true, JSON.stringify(listed.diagnostics));
    const modules = (listed.data as { modules: Array<{ name: string; source: string }> }).modules;
    assert.ok(
      modules.some((entry) => entry.name === 'toy' && entry.source === 'user'),
      'GSD_ATLAS_USER_DIR selects the user directory',
    );

    const built = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: repo.dir } });
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    const found = await composed.client.handle({
      protocol: PROTOCOL_VERSION,
      kind: 'code_find',
      args: { name: 'helper', repo: repo.dir },
    });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    assert.equal((found.data as { results: unknown[] }).results.length, 1);

    await composed.dispose();
    await composed.dispose();
    const after = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'code_find', args: { name: 'helper', repo: repo.dir } });
    assert.equal(after.diagnostics[0]?.code, 'host_closed');
    assert.deepEqual(stderr.written, [], 'a valid setup prints nothing');
  });

  it('reads the user config and reports a rejected file once on stderr', async (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    const userDir = path.join(tmp.path, 'user');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'config.json'), '{ not json');
    const stderr = sink();
    const composed = composeHost({
      cwd: tmp.path,
      env: { ...process.env, GSD_ATLAS_USER_DIR: userDir },
      home: path.join(tmp.path, 'home'),
      stderr,
    });
    t.after(async () => {
      await composed.dispose();
    });
    assert.equal(stderr.written.length, 1);
    assert.match(stderr.written[0] ?? '', /^gsd-atlas: warning user_config_ignored: /);
  });

  it('without GSD_ATLAS_USER_DIR the user directory is the config folder under the home directory', async (t) => {
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    const home = path.join(tmp.path, 'home');
    fs.cpSync(toyModule, path.join(home, '.config', 'gsd-atlas', 'languages', 'toy'), { recursive: true });
    const env: Record<string, string | undefined> = { ...process.env };
    delete env['GSD_ATLAS_USER_DIR'];
    const composed = composeHost({ cwd: tmp.path, env, home, stderr: sink() });
    t.after(async () => {
      await composed.dispose();
    });
    const listed = await composed.client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list' });
    const modules = (listed.data as { modules: Array<{ name: string; source: string }> }).modules;
    assert.ok(modules.some((entry) => entry.name === 'toy' && entry.source === 'user'));
  });
});
