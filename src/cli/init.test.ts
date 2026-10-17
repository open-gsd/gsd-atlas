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
  readonly platform?: NodeJS.Platform;
  /** False simulates a build whose bin supplies no io.init. */
  readonly withInit?: boolean;
  /** TEST ONLY hooks forwarded to the init environment: they run between init's read and its write. */
  readonly beforeWrite?: (file: string) => void | Promise<void>;
  readonly afterTemp?: (file: string) => void | Promise<void>;
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
                platform: options.platform ?? process.platform,
                env: {},
                mcp: { command: options.command ?? NODE, args: [options.entry ?? ENTRY] },
                ...(options.beforeWrite === undefined ? {} : { beforeWrite: options.beforeWrite }),
                ...(options.afterTemp === undefined ? {} : { afterTemp: options.afterTemp }),
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

/**
 * What a host does when it saves its own file while init runs: different bytes, the same size and the
 * same modification time, so only a compare of the content can notice.
 */
function hostRewrites(file: string): Buffer {
  const before = fs.statSync(file);
  const bytes = Buffer.from(fs.readFileSync(file));
  const at = bytes.indexOf('dark');
  assert.ok(at >= 0, 'the seeded file contains "dark"');
  bytes.write('dusk', at);
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, before.atime, before.mtime);
  assert.equal(fs.statSync(file).size, before.size);
  return bytes;
}

describe('gsd-atlas init and a config the host changes while init runs (WR-12)', () => {
  const REASON = /^config_changed_during_init/;

  it('changed between read and write: refused, the host bytes stay, no backup and no temp file', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    let hostBytes: Buffer | null = null;

    const out = await rig.run(['init', '--agent', 'claude'], {
      beforeWrite: (target) => {
        hostBytes = hostRewrites(target);
      },
    });

    assert.equal(out.code, 2);
    const host = out.envelope().data.hosts[0]!;
    assert.equal(host.action, 'refused');
    assert.match(host.reason ?? '', REASON);
    assert.ok(hostBytes !== null);
    assert.deepEqual(fs.readFileSync(file), hostBytes, 'the file holds the host bytes');
    assert.deepEqual(fs.readdirSync(rig.home), ['.claude.json'], 'no backup and no temp file');
  });

  it('changed after temp: refused, the temp file and the backup are removed, the host bytes stay', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    let hostBytes: Buffer | null = null;

    const out = await rig.run(['init', '--agent', 'claude'], {
      afterTemp: (target) => {
        hostBytes = hostRewrites(target);
      },
    });

    assert.equal(out.code, 2);
    const host = out.envelope().data.hosts[0]!;
    assert.equal(host.action, 'refused');
    assert.match(host.reason ?? '', REASON);
    assert.match(out.stderr.join(''), /config_changed_during_init/);
    assert.ok(hostBytes !== null);
    assert.deepEqual(fs.readFileSync(file), hostBytes);
    assert.deepEqual(fs.readdirSync(rig.home), ['.claude.json'], 'no backup and no temp file');
  });

  it('new file raced: a file that appears after init saw none is not overwritten', async () => {
    const rig = makeRig();
    fs.mkdirSync(path.join(rig.home, '.cursor'));
    const file = path.join(rig.home, '.cursor', 'mcp.json');
    const hostText = '{"mcpServers":{"theirs":{"command":"t"}}}\n';

    const out = await rig.run(['init', '--agent', 'cursor'], {
      beforeWrite: (target) => {
        fs.writeFileSync(target, hostText);
      },
    });

    assert.equal(out.code, 2);
    const host = out.envelope().data.hosts[0]!;
    assert.equal(host.action, 'refused');
    assert.match(host.reason ?? '', REASON);
    assert.equal(fs.readFileSync(file, 'utf8'), hostText);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['mcp.json']);
  });

  it('an existing file that the host deleted is not recreated by init', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);

    const out = await rig.run(['init', '--agent', 'claude'], {
      beforeWrite: (target) => {
        fs.rmSync(target);
      },
    });

    assert.equal(out.code, 2);
    assert.match(out.envelope().data.hosts[0]!.reason ?? '', REASON);
    assert.ok(!fs.existsSync(file));
    assert.deepEqual(fs.readdirSync(rig.home), []);
  });

  it('a dry run never calls the hooks and checks nothing', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    const original = fs.readFileSync(file);
    let calls = 0;

    const out = await rig.run(['init', '--agent', 'claude', '--dry-run'], {
      beforeWrite: () => {
        calls += 1;
      },
      afterTemp: () => {
        calls += 1;
      },
    });

    assert.equal(out.code, 0);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readFileSync(file), original);
  });

  it('two inits racing: the second to reach its compare sees the first rename and refuses, the file is the first result', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    let inner: Outcome | null = null;

    const outer = await rig.run(['init', '--agent', 'claude'], {
      beforeWrite: async () => {
        inner = await rig.run(['init', '--agent', 'claude'], { command: '/opt/other/node' });
      },
    });

    assert.ok(inner !== null);
    assert.equal((inner as Outcome).code, 0);
    assert.equal(outer.code, 2);
    assert.match(outer.envelope().data.hosts[0]!.reason ?? '', REASON);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(parsed.mcpServers['gsd-atlas'], { type: 'stdio', command: '/opt/other/node', args: [ENTRY] });
    assert.deepEqual(fs.readdirSync(rig.home).sort(), ['.claude.json', `.claude.json${BACKUP}`]);
  });

  it('a normal write still goes through with the hooks present, BOM kept', async () => {
    const rig = makeRig();
    const file = seedClaude(rig, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}\n')]));
    let calls = 0;

    const out = await rig.run(['init', '--agent', 'claude'], {
      beforeWrite: () => {
        calls += 1;
      },
      afterTemp: () => {
        calls += 1;
      },
    });

    assert.equal(out.code, 0);
    assert.equal(calls, 2, 'both hooks ran once');
    assert.deepEqual([...fs.readFileSync(file).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  it('concurrent inits: the file always parses with one gsd-atlas entry and no result is a silent loss', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);

    const [first, second] = await Promise.all([
      rig.run(['init', '--agent', 'claude']),
      rig.run(['init', '--agent', 'claude']),
    ]);

    for (const out of [first, second]) {
      const host = out.envelope().data.hosts[0]!;
      if (host.action === 'refused') {
        assert.match(host.reason ?? '', REASON);
        assert.equal(out.code, 2);
      } else {
        assert.ok(host.action === 'updated' || host.action === 'unchanged', host.action);
        assert.equal(out.code, 0);
      }
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown>; theme: string };
    assert.deepEqual(parsed.mcpServers['gsd-atlas'], CLAUDE_ENTRY);
    assert.deepEqual(parsed.mcpServers['other'], ORIGINAL_CONFIG.mcpServers.other);
    assert.equal(parsed.theme, 'dark');
    assert.deepEqual(fs.readdirSync(rig.home).sort(), ['.claude.json', `.claude.json${BACKUP}`], 'no temp file remains');
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

function seed(rig: Rig, relative: string, content: string | Buffer): string {
  const file = path.join(rig.home, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const CURSOR_ENTRY = { command: NODE, args: [ENTRY] };

describe('gsd-atlas init for Cursor', () => {
  it('merges mcpServers["gsd-atlas"] into ~/.cursor/mcp.json, keeps the rest and one backup, and is idempotent', async () => {
    const rig = makeRig();
    const original = `${JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: [1, 2] }, null, 2)}\n`;
    const file = seed(rig, '.cursor/mcp.json', original);

    const out = await rig.run(['init', '--agent', 'cursor']);

    assert.equal(out.code, 0);
    assert.deepEqual(out.envelope().data.hosts, [{ agent: 'cursor', file, action: 'updated' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      mcpServers: { other: { command: 'x' }, 'gsd-atlas': CURSOR_ENTRY },
      extra: [1, 2],
    });
    assert.equal(fs.readFileSync(`${file}${BACKUP}`, 'utf8'), original);
    const afterFirst = fs.readFileSync(file);

    const second = await rig.run(['init', '--agent', 'cursor']);
    assert.equal(second.envelope().data.hosts[0]!.action, 'unchanged');
    assert.deepEqual(fs.readFileSync(file), afterFirst);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['mcp.json', `mcp.json${BACKUP}`]);
  });

  it('creates the file containing only the gsd-atlas entry when the .cursor folder has no file', async () => {
    const rig = makeRig();
    fs.mkdirSync(path.join(rig.home, '.cursor'));

    const out = await rig.run(['init', '--agent', 'cursor']);

    const file = path.join(rig.home, '.cursor', 'mcp.json');
    assert.equal(out.code, 0);
    assert.deepEqual(out.envelope().data.hosts, [{ agent: 'cursor', file, action: 'created' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: { 'gsd-atlas': CURSOR_ENTRY } });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['mcp.json'], 'a new file has nothing to back up');
  });

  it('refused: a ~/.cursor/mcp.json that does not parse is refused untouched', async () => {
    const rig = makeRig();
    const file = seed(rig, '.cursor/mcp.json', '{ "mcpServers": ');
    const out = await rig.run(['init', '--agent', 'cursor']);
    assert.equal(out.code, 2);
    assert.equal(out.envelope().data.hosts[0]!.action, 'refused');
    assert.equal(fs.readFileSync(file, 'utf8'), '{ "mcpServers": ');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['mcp.json']);
  });
});

describe('gsd-atlas init for Codex', () => {
  const table = (command = NODE, entry = ENTRY): string[] => ['[mcp_servers.gsd-atlas]', `command = "${command}"`, `args = ["${entry}"]`];

  it('appends the [mcp_servers.gsd-atlas] table after a blank line and keeps every existing byte', async () => {
    const rig = makeRig();
    const before = 'model = "o3"\n\n[other]\nkey = 1 # keep this comment\n';
    const file = seed(rig, '.codex/config.toml', before);

    const out = await rig.run(['init', '--agent', 'codex']);

    assert.equal(out.code, 0);
    assert.deepEqual(out.envelope().data.hosts, [{ agent: 'codex', file, action: 'updated' }]);
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, `${before}\n${table().join('\n')}\n`);
    assert.equal(fs.readFileSync(`${file}${BACKUP}`, 'utf8'), before);
  });

  it('adds the missing final newline before the blank line', async () => {
    const rig = makeRig();
    const file = seed(rig, '.codex/config.toml', 'model = "o3"');
    await rig.run(['init', '--agent', 'codex']);
    assert.equal(fs.readFileSync(file, 'utf8'), `model = "o3"\n\n${table().join('\n')}\n`);
  });

  it('replaces only the existing gsd-atlas block, from its header to the next table, and nothing else changes (Codex replace-block)', async () => {
    const rig = makeRig();
    const head = ['model = "o3"', '', '# my servers', '[mcp_servers.first]', 'command = "first"', ''];
    const old = ['[mcp_servers.gsd-atlas]', 'command = "/old/node"', 'args = ["/old/entry.js"]', ''];
    const tail = ['[mcp_servers.other]', 'command = "other"', 'args = ["--flag"]', ''];
    const file = seed(rig, '.codex/config.toml', [...head, ...old, ...tail].join('\n'));

    const out = await rig.run(['init', '--agent', 'codex']);

    assert.equal(out.code, 0);
    assert.equal(out.envelope().data.hosts[0]!.action, 'updated');
    assert.equal(fs.readFileSync(file, 'utf8'), [...head, ...table(), '', ...tail].join('\n'));
  });

  it('reports unchanged for an identical block and leaves the bytes alone', async () => {
    const rig = makeRig();
    const text = ['model = "o3"', '', ...table(), '', '[mcp_servers.other]', 'command = "o"', ''].join('\n');
    const file = seed(rig, '.codex/config.toml', text);
    const out = await rig.run(['init', '--agent', 'codex']);
    assert.equal(out.code, 0);
    assert.equal(out.envelope().data.hosts[0]!.action, 'unchanged');
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.toml']);
  });

  it('creates the file with just the table when the .codex folder has no file', async () => {
    const rig = makeRig();
    fs.mkdirSync(path.join(rig.home, '.codex'));
    const out = await rig.run(['init', '--agent', 'codex']);
    const file = path.join(rig.home, '.codex', 'config.toml');
    assert.deepEqual(out.envelope().data.hosts, [{ agent: 'codex', file, action: 'created' }]);
    assert.equal(fs.readFileSync(file, 'utf8'), `${table().join('\n')}\n`);
  });

  it('escapes backslashes and quotes in Windows paths as TOML basic strings', async () => {
    const rig = makeRig();
    fs.mkdirSync(path.join(rig.home, '.codex'));
    const command = 'C:\\Program Files\\nodejs\\node.exe';
    const entry = 'C:\\gsd "atlas"\\bin\\gsd-atlas-mcp.js';
    await rig.run(['init', '--agent', 'codex'], { command, entry, platform: 'win32' });
    assert.equal(
      fs.readFileSync(path.join(rig.home, '.codex', 'config.toml'), 'utf8'),
      [
        '[mcp_servers.gsd-atlas]',
        'command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
        'args = ["C:\\\\gsd \\"atlas\\"\\\\bin\\\\gsd-atlas-mcp.js"]',
        '',
      ].join('\n'),
    );
  });

  it('keeps CRLF line endings for the new block', async () => {
    const rig = makeRig();
    const file = seed(rig, '.codex/config.toml', 'model = "o3"\r\n[other]\r\nkey = 1\r\n');
    await rig.run(['init', '--agent', 'codex']);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text, `model = "o3"\r\n[other]\r\nkey = 1\r\n\r\n${table().join('\r\n')}\r\n`);
  });

  const refusals: ReadonlyArray<{ title: string; bytes: Buffer }> = [
    { title: 'a NUL byte', bytes: Buffer.from('model = "o3"\0\n') },
    { title: 'a table header without a closing bracket', bytes: Buffer.from('model = "o3"\n[mcp_servers.other\ncommand = "x"\n') },
    { title: 'the table written with a quoted key', bytes: Buffer.from('[mcp_servers."gsd-atlas"]\ncommand = "x"\n') },
  ];
  for (const { title, bytes } of refusals) {
    it(`refused: ${title} is refused untouched with exit 2`, async () => {
      const rig = makeRig();
      const file = seed(rig, '.codex/config.toml', bytes);
      const out = await rig.run(['init', '--agent', 'codex']);
      assert.equal(out.code, 2);
      assert.equal(out.envelope().data.hosts[0]!.action, 'refused');
      assert.deepEqual(fs.readFileSync(file), bytes);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.toml']);
    });
  }
});

describe('gsd-atlas init host detection and the agent filter', () => {
  it('skips every host as not_detected, with exit 0 and a stderr line, when the home has no agent config', async () => {
    const rig = makeRig();
    const out = await rig.run(['init']);
    assert.equal(out.code, 0);
    const envelope = out.envelope();
    assert.equal(envelope.ok, true);
    assert.deepEqual(
      envelope.data.hosts.map((host) => [host.agent, host.action, host.reason]),
      [
        ['claude', 'skipped', 'not_detected'],
        ['cursor', 'skipped', 'not_detected'],
        ['codex', 'skipped', 'not_detected'],
      ],
    );
    assert.match(out.stderr.join(''), /no agent host was found/);
    assert.deepEqual(fs.readdirSync(rig.home), []);
  });

  it('skips Claude Code as config_not_found and prints the exact claude mcp add line when only the folder exists (config_not_found)', async () => {
    const rig = makeRig();
    fs.mkdirSync(path.join(rig.home, '.claude'));
    const out = await rig.run(['init', '--agent', 'claude']);
    assert.equal(out.code, 0);
    const host = out.envelope().data.hosts[0]!;
    assert.equal(host.action, 'skipped');
    assert.equal(host.reason, 'config_not_found');
    const lines = out.stderr.join('').split('\n');
    assert.ok(lines.includes(`claude mcp add --scope user gsd-atlas -- ${NODE} ${ENTRY}`), lines.join('\n'));
    assert.ok(!fs.existsSync(path.join(rig.home, '.claude.json')), 'init does not create the file the host owns');
  });

  it('quotes a manual-command word that contains a space', async () => {
    const rig = makeRig();
    fs.mkdirSync(path.join(rig.home, '.claude'));
    const out = await rig.run(['init', '--agent', 'claude'], { command: '/opt/my node/bin/node', platform: 'linux' });
    assert.ok(out.stderr.join('').split('\n').includes(`claude mcp add --scope user gsd-atlas -- "/opt/my node/bin/node" ${ENTRY}`));
  });

  it('with --agent codex touches only Codex', async () => {
    const rig = makeRig();
    const claude = seedClaude(rig);
    const cursor = seed(rig, '.cursor/mcp.json', '{"mcpServers":{}}\n');
    const codex = seed(rig, '.codex/config.toml', 'model = "o3"\n');
    const claudeBytes = fs.readFileSync(claude);
    const cursorBytes = fs.readFileSync(cursor);

    const out = await rig.run(['init', '--agent', 'codex']);

    assert.equal(out.code, 0);
    assert.deepEqual(out.envelope().data.hosts.map((host) => host.agent), ['codex']);
    assert.deepEqual(fs.readFileSync(claude), claudeBytes);
    assert.deepEqual(fs.readFileSync(cursor), cursorBytes);
    assert.ok(fs.readFileSync(codex, 'utf8').includes('[mcp_servers.gsd-atlas]'));
  });

  it('registers all three hosts in a default run, in the order claude, cursor, codex', async () => {
    const rig = makeRig();
    seedClaude(rig);
    seed(rig, '.cursor/mcp.json', '{}\n');
    seed(rig, '.codex/config.toml', '');
    const out = await rig.run(['init']);
    assert.equal(out.code, 0);
    assert.deepEqual(
      out.envelope().data.hosts.map((host) => [host.agent, host.action]),
      [['claude', 'updated'], ['cursor', 'updated'], ['codex', 'updated']],
    );
  });

  it('exits 1 for an unknown agent without touching any file', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    const original = fs.readFileSync(file);
    const out = await rig.run(['init', '--agent', 'unknown']);
    assert.equal(out.code, 1);
    assert.deepEqual(out.stdout, []);
    assert.match(out.stderr.join(''), /unknown agent "unknown"/);
    assert.deepEqual(fs.readFileSync(file), original);
  });

  it('refuses Claude, updates Cursor and exits 2 in a mixed run', async () => {
    const rig = makeRig();
    const claude = seedClaude(rig, '{ not json');
    const cursor = seed(rig, '.cursor/mcp.json', '{"mcpServers":{}}\n');

    const out = await rig.run(['init']);

    assert.equal(out.code, 2);
    const envelope = out.envelope();
    assert.equal(envelope.ok, false);
    assert.deepEqual(
      envelope.data.hosts.map((host) => [host.agent, host.action]),
      [['claude', 'refused'], ['cursor', 'updated'], ['codex', 'skipped']],
    );
    assert.equal(fs.readFileSync(claude, 'utf8'), '{ not json');
    assert.deepEqual(JSON.parse(fs.readFileSync(cursor, 'utf8')).mcpServers['gsd-atlas'], CURSOR_ENTRY);
  });
});
