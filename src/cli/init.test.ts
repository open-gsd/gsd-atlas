import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { Envelope, HostClient } from '../host-client/index.ts';
import { makeTempDir, realPath } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import { runCli } from './index.ts';

const NODE = '/opt/node/bin/node';
const ENTRY = '/opt/gsd-atlas/dist/bin/gsd-atlas-mcp.js';

interface InitHost {
  readonly agent: string;
  readonly file: string;
  readonly action: string;
  readonly reason?: string;
}

interface InitEnvelope {
  readonly schema: string;
  readonly ok: boolean;
  readonly data: { readonly dryRun: boolean; readonly hosts: readonly InitHost[] };
}

interface Outcome {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  envelope(): InitEnvelope;
}

interface RunOptions {
  readonly command?: string;
  readonly entry?: string;
  readonly cwd?: string;
  /** False simulates a build whose bin supplies no io.init. */
  readonly withInit?: boolean;
}

interface Rig {
  readonly home: string;
  readonly cwd: string;
  run(argv: readonly string[], options?: RunOptions): Promise<Outcome>;
}

const rigs: TempDir[] = [];

afterEach(() => {
  for (const tmp of rigs.splice(0)) {
    tmp.cleanup();
  }
});

/** The host must never be contacted by init: it only edits files. */
const client: HostClient = {
  async handle(): Promise<Envelope> {
    throw new Error('init must not contact the host');
  },
};

function makeRig(): Rig {
  const tmp = makeTempDir();
  rigs.push(tmp);
  const base = realPath(tmp.path);
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  return {
    home,
    cwd,
    async run(argv, options = {}) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const io = {
        client,
        version: () => '9.9.9',
        stdout: { write: (text: string) => stdout.push(text) },
        stderr: { write: (text: string) => stderr.push(text) },
        ...(options.withInit === false
          ? {}
          : {
              init: {
                home,
                cwd: options.cwd ?? cwd,
                platform: process.platform,
                env: {},
                mcp: { command: options.command ?? NODE, args: [options.entry ?? ENTRY] },
              },
            }),
      };
      const code = await runCli(argv, io);
      return {
        code,
        stdout,
        stderr,
        envelope() {
          assert.equal(stdout.length, 1, 'exactly one JSON envelope on stdout');
          assert.ok(stdout[0]!.endsWith('\n'));
          return JSON.parse(stdout[0]!) as InitEnvelope;
        },
      };
    },
  };
}

const CLAUDE_ENTRY = { type: 'stdio', command: NODE, args: [ENTRY] };

const ORIGINAL_CONFIG = {
  theme: 'dark',
  projects: { '/work/a': { allowedTools: [], history: [{ display: 'x' }] } },
  mcpServers: { other: { type: 'stdio', command: 'other', args: ['--x'] } },
};

function seedClaude(rig: Rig, text: string | Buffer = `${JSON.stringify(ORIGINAL_CONFIG, null, 2)}\n`): string {
  const file = path.join(rig.home, '.claude.json');
  fs.writeFileSync(file, text);
  return file;
}

const BACKUP = '.gsd-atlas-backup';

describe('gsd-atlas init for Claude Code', () => {
  it('updates ~/.claude.json: keeps every other key, adds the gsd-atlas server and keeps one backup', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    const original = fs.readFileSync(file);

    const out = await rig.run(['init', '--agent', 'claude']);

    assert.equal(out.code, 0);
    const envelope = out.envelope();
    assert.equal(envelope.schema, 'gsd-atlas.init/1');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.dryRun, false);
    assert.deepEqual(envelope.data.hosts, [{ agent: 'claude', file, action: 'updated' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      ...ORIGINAL_CONFIG,
      mcpServers: { ...ORIGINAL_CONFIG.mcpServers, 'gsd-atlas': CLAUDE_ENTRY },
    });
    assert.deepEqual(fs.readFileSync(`${file}${BACKUP}`), original, 'backup holds the original bytes');
    assert.deepEqual(fs.readdirSync(rig.home).sort(), ['.claude.json', `.claude.json${BACKUP}`], 'no temp file remains');
  });

  it('reports unchanged on a second run and leaves the file and the backup byte-identical', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    await rig.run(['init', '--agent', 'claude']);
    const afterFirst = fs.readFileSync(file);
    const backupAfterFirst = fs.readFileSync(`${file}${BACKUP}`);

    const second = await rig.run(['init', '--agent', 'claude']);

    assert.equal(second.code, 0);
    assert.deepEqual(second.envelope().data.hosts, [{ agent: 'claude', file, action: 'unchanged' }]);
    assert.deepEqual(fs.readFileSync(file), afterFirst);
    assert.deepEqual(fs.readFileSync(`${file}${BACKUP}`), backupAfterFirst);
  });

  it('updates only the gsd-atlas entry when the launch command changes, and the backup keeps the very first original', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    const original = fs.readFileSync(file);
    await rig.run(['init', '--agent', 'claude']);

    const moved = await rig.run(['init', '--agent', 'claude'], { entry: '/opt/other/gsd-atlas-mcp.js' });

    assert.equal(moved.code, 0);
    assert.equal(moved.envelope().data.hosts[0]!.action, 'updated');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      ...ORIGINAL_CONFIG,
      mcpServers: {
        ...ORIGINAL_CONFIG.mcpServers,
        'gsd-atlas': { type: 'stdio', command: NODE, args: ['/opt/other/gsd-atlas-mcp.js'] },
      },
    });
    assert.deepEqual(fs.readFileSync(`${file}${BACKUP}`), original);
  });

  const refusals: ReadonlyArray<{ title: string; bytes: Buffer; reason: RegExp }> = [
    { title: 'text that is not valid JSON', bytes: Buffer.from('{ "theme": "dark", '), reason: /JSON/ },
    { title: 'a JSON array', bytes: Buffer.from('[1, 2, 3]\n'), reason: /object/ },
    { title: 'a NUL byte', bytes: Buffer.from('{"theme":"dark"}\0\n'), reason: /NUL/ },
    { title: 'an mcpServers value that is not an object', bytes: Buffer.from('{"mcpServers": []}\n'), reason: /mcpServers/ },
  ];
  for (const { title, bytes, reason } of refusals) {
    it(`refused: ${title} is refused untouched with exit 2, no backup and no temp file`, async () => {
      const rig = makeRig();
      const file = seedClaude(rig, bytes);

      const out = await rig.run(['init', '--agent', 'claude']);

      assert.equal(out.code, 2);
      const envelope = out.envelope();
      assert.equal(envelope.ok, false);
      assert.equal(envelope.data.hosts[0]!.action, 'refused');
      assert.match(envelope.data.hosts[0]!.reason ?? '', reason);
      assert.match(out.stderr.join(''), reason);
      assert.deepEqual(fs.readFileSync(file), bytes, 'file is byte-identical');
      assert.deepEqual(fs.readdirSync(rig.home), ['.claude.json'], 'no backup and no temp file');
    });
  }

  it('dry-run reports updated for the same input and writes nothing, no backup either', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    const original = fs.readFileSync(file);

    const out = await rig.run(['init', '--agent', 'claude', '--dry-run']);

    assert.equal(out.code, 0);
    const envelope = out.envelope();
    assert.equal(envelope.data.dryRun, true);
    assert.deepEqual(envelope.data.hosts, [{ agent: 'claude', file, action: 'updated' }]);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(fs.readdirSync(rig.home), ['.claude.json']);
  });

  it('keeps a UTF-8 BOM and CRLF line endings after the update (BOM and CRLF)', async () => {
    const rig = makeRig();
    const crlf = JSON.stringify(ORIGINAL_CONFIG, null, 2).replace(/\n/g, '\r\n');
    const file = seedClaude(rig, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${crlf}\r\n`)]));

    const out = await rig.run(['init', '--agent', 'claude']);

    assert.equal(out.code, 0);
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM kept');
    const text = bytes.subarray(3).toString('utf8');
    assert.ok(text.includes('\r\n'));
    assert.ok(!/(?<!\r)\n/.test(text), 'every line ending is still CRLF');
    assert.ok(text.endsWith('\r\n'));
    assert.deepEqual(JSON.parse(text).mcpServers['gsd-atlas'], CLAUDE_ENTRY);
  });

  it('writes through a symlink config file to its real target and the link survives (symlink)', async (t) => {
    const rig = makeRig();
    const dotfiles = path.join(rig.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const real = path.join(dotfiles, 'claude.json');
    fs.writeFileSync(real, `${JSON.stringify(ORIGINAL_CONFIG, null, 2)}\n`);
    const link = path.join(rig.home, '.claude.json');
    try {
      fs.symlinkSync(real, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('symbolic links need extra rights on this Windows account');
        return;
      }
      throw error;
    }

    const out = await rig.run(['init', '--agent', 'claude']);

    assert.equal(out.code, 0);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link remains a link');
    assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')).mcpServers['gsd-atlas'], CLAUDE_ENTRY);
    assert.ok(fs.existsSync(`${real}${BACKUP}`), 'the backup sits beside the real file');
    assert.deepEqual(fs.readdirSync(dotfiles).sort(), ['claude.json', `claude.json${BACKUP}`]);
  });
});

describe('gsd-atlas init and the working directory', () => {
  function listing(dir: string): string[] {
    return fs.readdirSync(dir, { recursive: true }).map(String).sort();
  }

  it('creates no file inside the working repository (no file in cwd) and suggests gsd-atlas build once', async () => {
    const rig = makeRig();
    seedClaude(rig);
    fs.mkdirSync(path.join(rig.cwd, '.git'));
    fs.mkdirSync(path.join(rig.cwd, 'src'));
    const before = listing(rig.cwd);

    const out = await rig.run(['init', '--agent', 'claude']);

    assert.equal(out.code, 0);
    assert.deepEqual(listing(rig.cwd), before, 'the repository is unchanged');
    const suggestions = out.stderr.join('').split('\n').filter((line) => line.includes('gsd-atlas build'));
    assert.equal(suggestions.length, 1);
  });

  it('finds the repository from a subdirectory of it', async () => {
    const rig = makeRig();
    seedClaude(rig);
    fs.mkdirSync(path.join(rig.cwd, '.git'));
    const deep = path.join(rig.cwd, 'src', 'deep');
    fs.mkdirSync(deep, { recursive: true });

    const out = await rig.run(['init', '--agent', 'claude'], { cwd: deep });

    assert.equal(out.stderr.join('').split('\n').filter((line) => line.includes('gsd-atlas build')).length, 1);
  });

  it('prints no suggestion when the repository already has an atlas index or when cwd is not in a repository', async () => {
    const indexed = makeRig();
    seedClaude(indexed);
    fs.mkdirSync(path.join(indexed.cwd, '.git', 'gsd-atlas'), { recursive: true });
    const withIndex = await indexed.run(['init', '--agent', 'claude']);
    assert.ok(!withIndex.stderr.join('').includes('gsd-atlas build'));

    const bare = makeRig();
    seedClaude(bare);
    const outside = await bare.run(['init', '--agent', 'claude']);
    assert.ok(!outside.stderr.join('').includes('gsd-atlas build'));
  });

  it('never writes a registration into the repository or the working directory', async () => {
    const rig = makeRig();
    seedClaude(rig);
    fs.mkdirSync(path.join(rig.cwd, '.git'));
    await rig.run(['init', '--agent', 'claude']);
    assert.ok(!fs.existsSync(path.join(rig.cwd, '.mcp.json')));
    assert.deepEqual(listing(rig.cwd), ['.git']);
  });
});

describe('gsd-atlas init command line', () => {
  it('exits 1 for extra arguments without touching any file', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    const original = fs.readFileSync(file);
    const out = await rig.run(['init', 'extra']);
    assert.equal(out.code, 1);
    assert.deepEqual(out.stdout, []);
    assert.match(out.stderr.join(''), /^gsd-atlas: /);
    assert.deepEqual(fs.readFileSync(file), original);
  });

  it('exits 1 when --dry-run or --agent is given to another command', async () => {
    const rig = makeRig();
    assert.equal((await rig.run(['lang', 'list', '--dry-run'])).code, 1);
    assert.equal((await rig.run(['lang', 'list', '--agent', 'claude'])).code, 1);
  });

  it('exits 2 with a reason when the build supplies no init environment', async () => {
    const rig = makeRig();
    const out = await rig.run(['init'], { withInit: false });
    assert.equal(out.code, 2);
    assert.deepEqual(out.stdout, []);
    assert.match(out.stderr.join(''), /init is not available in this build/);
  });

  it('lists init in the usage text', async () => {
    const rig = makeRig();
    const out = await rig.run(['--help']);
    assert.match(out.stdout.join(''), /gsd-atlas init \[--agent claude\|cursor\|codex\] \[--dry-run\]/);
  });

  it('refuses a launch command that is not an absolute path, so a PATH lookup is never registered', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    const original = fs.readFileSync(file);
    const out = await rig.run(['init', '--agent', 'claude'], { command: 'node' });
    assert.equal(out.code, 2);
    assert.match(out.stderr.join(''), /absolute/);
    assert.deepEqual(fs.readFileSync(file), original);
  });
});
