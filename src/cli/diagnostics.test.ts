/**
 * `gsd-atlas diagnostics` (SKL-03): the user-facing surface of the consent model. Task 1 of plan 03-21 proves the
 * smallest report through the CLI and a real in-process Host over a temporary user directory: header-only consent gives an exact
 * preview, no consent gives "off", and nothing is written by a preview.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION, createInProcessHostClient } from '../host-client/index.ts';
import type { Envelope, HostClient, Request } from '../host-client/index.ts';
import { makeTempDir } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import { EXIT_OK, EXIT_USAGE, runCli } from './index.ts';

const VERSION = '1.2.3';
const WORK = path.resolve('some', 'work');

interface Session {
  readonly tmp: TempDir;
  readonly userDir: string;
  readonly requests: Request[];
  readonly stdout: string[];
  readonly stderr: string[];
  run(argv: readonly string[]): Promise<number>;
  /** The one envelope printed to stdout by the last command. */
  envelope(): Envelope;
}

/** A CLI over a real in-process Host whose user directory is a temporary folder. No tenant is ever needed. */
function session(): Session {
  const tmp = makeTempDir();
  const userDir = path.join(tmp.path, 'user');
  const real = createInProcessHostClient({
    roots: { repoRoot: WORK, userDir, builtinDir: null, npmRoots: [] },
    // Diagnostics never need a grammar engine: only a tenant does.
    engine: undefined as never,
    userDir,
    version: VERSION,
  });
  const requests: Request[] = [];
  const client: HostClient = {
    handle(request: Request): Promise<Envelope> {
      requests.push(request);
      return real.handle(request);
    },
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    tmp,
    userDir,
    requests,
    stdout,
    stderr,
    run: (argv) =>
      runCli(argv, {
        client,
        version: () => VERSION,
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
        cwd: WORK,
      }),
    envelope: () => JSON.parse(stdout[stdout.length - 1] as string) as Envelope,
  };
}

const HEADER_ONLY = {
  catalogVersion: 1,
  types: { header: { state: 'approved', fields: ['atlas_version', 'catalog_version'] } },
};

describe('diagnostics preview', () => {
  it('header-only consent: prints one envelope whose data holds the title, labels and body', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    fs.mkdirSync(s.userDir, { recursive: true });
    fs.writeFileSync(path.join(s.userDir, 'diagnostics.json'), JSON.stringify(HEADER_ONLY));

    assert.equal(await s.run(['diagnostics', 'preview']), EXIT_OK, s.stderr.join(''));
    assert.equal(s.stdout.length, 1, 'one envelope on stdout');
    const envelope = s.envelope();
    assert.equal(envelope.ok, true);
    assert.equal(envelope.schema, 'gsd-atlas.diagnostics/1');
    const data = envelope.data as { enabled: boolean; title: string; labels: string[]; body: string; json: unknown };
    assert.equal(data.enabled, true);
    assert.equal(data.title, `[diagnostics] atlas ${VERSION}`);
    assert.deepEqual(data.labels, ['diagnostics']);
    assert.ok(data.body.includes('```diagnostics-v1\n'));
    assert.deepEqual(data.json, { catalog_version: 1, atlas_version: VERSION });
    assert.deepEqual(s.requests, [{ protocol: PROTOCOL_VERSION, kind: 'diagnostics', args: { action: 'preview' } }]);
  });

  it('two previews print the same bytes', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    fs.mkdirSync(s.userDir, { recursive: true });
    fs.writeFileSync(path.join(s.userDir, 'diagnostics.json'), JSON.stringify(HEADER_ONLY));
    await s.run(['diagnostics', 'preview']);
    await s.run(['diagnostics', 'preview']);
    assert.equal(s.stdout[0], s.stdout[1]);
  });

  it('no consent: says diagnostics are off and how to enable them, exit 0, data { enabled: false }', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'preview']), EXIT_OK, s.stderr.join(''));
    const envelope = s.envelope();
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data, { enabled: false });
    const said = s.stderr.join('');
    assert.match(said, /Diagnostics are off/);
    assert.match(said, /gsd-atlas diagnostics enable/);
  });

  it('nothing is written: no diagnostics.json, no folder, after a preview with no consent', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    await s.run(['diagnostics', 'preview']);
    assert.equal(fs.existsSync(s.userDir), false);
  });

  it('after enabling the header only, diagnostics.json is the only file in the user directory', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    fs.mkdirSync(s.userDir, { recursive: true });
    fs.writeFileSync(path.join(s.userDir, 'diagnostics.json'), JSON.stringify(HEADER_ONLY));
    await s.run(['diagnostics', 'preview']);
    assert.deepEqual(fs.readdirSync(s.userDir), ['diagnostics.json']);
    assert.deepEqual(fs.readdirSync(s.tmp.path), ['user'], 'nothing else was created anywhere beside it');
  });
});

describe('diagnostics usage', () => {
  it('a missing or unknown sub-command is a usage error', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics']), EXIT_USAGE);
    assert.match(s.stderr.join(''), /enable\|types\|preview\|disable\|history/);
    assert.equal(await s.run(['diagnostics', 'frobnicate']), EXIT_USAGE);
    assert.equal(s.requests.length, 0, 'nothing was sent');
  });

  it('preview takes no positional arguments', async (t) => {
    const s = session();
    t.after(() => s.tmp.cleanup());
    assert.equal(await s.run(['diagnostics', 'preview', 'extra']), EXIT_USAGE);
    assert.equal(s.requests.length, 0);
  });
});
