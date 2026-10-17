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
  /** The host client init is given (see {@link scriptedClient}). */
  readonly client?: HostClient;
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

/**
 * The default client: init edits files and contacts the host only for the `no index yet` hint, so a test that does not
 * script that question gets a rejected call, which init answers with the file-system probe.
 */
const client: HostClient = {
  async handle(): Promise<Envelope> {
    throw new Error('init must not contact the host');
  },
};

/** A client double that records every request and answers the `index_state` question as scripted. */
function scriptedClient(answer: (cwd: unknown) => Envelope | Error): { readonly client: HostClient; readonly requests: Array<{ kind: string; args: unknown }> } {
  const requests: Array<{ kind: string; args: unknown }> = [];
  return {
    requests,
    client: {
      async handle(request): Promise<Envelope> {
        requests.push({ kind: request.kind, args: request.args });
        const reply = answer((request.args as { cwd?: unknown } | undefined)?.cwd);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}

const indexStateReply = (repo: string, indexed: boolean): Envelope => ({
  schema: 'gsd-atlas.index-state/1',
  ok: true,
  data: { repo, indexed },
  diagnostics: [],
});

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
        client: options.client ?? client,
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

  it('changed after temp: refused, the temp file is removed, the host bytes stay, the backup holds the file as init read it', async () => {
    const rig = makeRig();
    const file = seedClaude(rig);
    const original = fs.readFileSync(file);
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
    assert.deepEqual(fs.readdirSync(rig.home).sort(), ['.claude.json', `.claude.json${BACKUP}`], 'no temp file remains');
    assert.deepEqual(fs.readFileSync(`${file}${BACKUP}`), original);
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

  it('the hint names the repository and does not claim the repository has no index', async () => {
    const rig = makeRig();
    seedClaude(rig);
    fs.mkdirSync(path.join(rig.cwd, '.git'));

    const out = await rig.run(['init', '--agent', 'claude']);

    const lines = out.stderr.join('').split('\n');
    assert.ok(lines.includes(`gsd-atlas: to index ${rig.cwd}, run \`gsd-atlas build\` inside it`), lines.join('\n'));
    assert.ok(!out.stderr.join('').includes('has no atlas index yet'));
  });

  it('prints no hint on a dry run or after a refusal', async () => {
    const dry = makeRig();
    seedClaude(dry);
    fs.mkdirSync(path.join(dry.cwd, '.git'));
    assert.ok(!(await dry.run(['init', '--agent', 'claude', '--dry-run'])).stderr.join('').includes('gsd-atlas build'));

    const refused = makeRig();
    seedClaude(refused, '{ not json');
    fs.mkdirSync(path.join(refused.cwd, '.git'));
    assert.ok(!(await refused.run(['init', '--agent', 'claude'])).stderr.join('').includes('gsd-atlas build'));
  });

  describe('linked worktree hint', () => {
    /** A main checkout `main/.git` and a linked worktree `wt` whose `.git` file points into `main/.git/worktrees/wt1`. */
    function linkedWorktree(rig: Rig, commondir: 'relative' | 'absolute' | 'none'): { common: string; worktree: string } {
      const base = path.dirname(rig.cwd);
      const common = path.join(base, 'main', '.git');
      const gitDir = path.join(common, 'worktrees', 'wt1');
      const worktree = path.join(base, 'wt');
      fs.mkdirSync(gitDir, { recursive: true });
      fs.mkdirSync(worktree);
      fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
      if (commondir === 'relative') {
        fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
      } else if (commondir === 'absolute') {
        fs.writeFileSync(path.join(gitDir, 'commondir'), `${common}\n`);
      }
      return { common, worktree };
    }

    for (const kind of ['relative', 'absolute'] as const) {
      it(`linked worktree hint: no hint when the common directory (${kind} commondir) holds gsd-atlas`, async () => {
        const rig = makeRig();
        seedClaude(rig);
        const { common, worktree } = linkedWorktree(rig, kind);
        fs.mkdirSync(path.join(common, 'gsd-atlas'));

        const out = await rig.run(['init', '--agent', 'claude'], { cwd: worktree });

        assert.equal(out.code, 0);
        assert.ok(!out.stderr.join('').includes('gsd-atlas build'), out.stderr.join(''));
      });

      it(`linked worktree hint: the hint appears when the common directory (${kind} commondir) has no gsd-atlas`, async () => {
        const rig = makeRig();
        seedClaude(rig);
        const { worktree } = linkedWorktree(rig, kind);

        const out = await rig.run(['init', '--agent', 'claude'], { cwd: worktree });

        assert.ok(out.stderr.join('').split('\n').includes(`gsd-atlas: to index ${worktree}, run \`gsd-atlas build\` inside it`));
      });
    }

    it('linked worktree hint: without a commondir file the git directory itself is the common directory', async () => {
      const rig = makeRig();
      seedClaude(rig);
      const { worktree } = linkedWorktree(rig, 'none');
      const gitDir = path.join(path.dirname(rig.cwd), 'main', '.git', 'worktrees', 'wt1');
      fs.mkdirSync(path.join(gitDir, 'gsd-atlas'));

      const out = await rig.run(['init', '--agent', 'claude'], { cwd: worktree });

      assert.ok(!out.stderr.join('').includes('gsd-atlas build'));
    });
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

describe('gsd-atlas init and the build hint through the Host (plan 02-44, IN-04)', () => {
  const buildLines = (out: Outcome): string[] => out.stderr.join('').split('\n').filter((line) => line.includes('gsd-atlas build'));

  it('indexed: when the Host says the repository has an index there is no hint, even if the git directory holds no gsd-atlas folder (a store in the cache directory)', async () => {
    const rig = makeRig();
    seedClaude(rig);
    fs.mkdirSync(path.join(rig.cwd, '.git'));
    const host = scriptedClient(() => indexStateReply(rig.cwd, true));

    const out = await rig.run(['init', '--agent', 'claude'], { client: host.client });

    assert.equal(out.code, 0);
    assert.deepEqual(buildLines(out), []);
    assert.deepEqual(host.requests, [{ kind: 'index_state', args: { cwd: rig.cwd } }], 'one question, about the working directory');
  });

  it('not indexed: the hint names the repository root the Host reported', async () => {
    const rig = makeRig();
    seedClaude(rig);
    fs.mkdirSync(path.join(rig.cwd, '.git'));
    const root = path.join(rig.cwd, 'host-root');
    const host = scriptedClient(() => indexStateReply(root, false));

    const out = await rig.run(['init', '--agent', 'claude'], { client: host.client });

    assert.deepEqual(buildLines(out), [`gsd-atlas: to index ${root}, run \`gsd-atlas build\` inside it`]);
  });

  const unusable: ReadonlyArray<{ title: string; reply: Envelope | Error }> = [
    { title: 'an error envelope', reply: { schema: 'gsd-atlas.error/1', ok: false, data: null, diagnostics: [{ code: 'not_a_repo', severity: 'error', message: 'x' }] } },
    { title: 'a rejected call', reply: new Error('host exploded') },
    { title: 'an unexpected reply', reply: { schema: 'gsd-atlas.something-else/1', ok: true, data: { indexed: 'maybe' }, diagnostics: [] } },
    { title: 'a reply without data', reply: { schema: 'gsd-atlas.index-state/1', ok: true, data: null, diagnostics: [] } },
  ];
  for (const { title, reply } of unusable) {
    it(`${title}: the file-system probe decides, as it did before`, async () => {
      const without = makeRig();
      seedClaude(without);
      fs.mkdirSync(path.join(without.cwd, '.git'));
      const hint = await without.run(['init', '--agent', 'claude'], { client: scriptedClient(() => reply).client });
      assert.deepEqual(buildLines(hint), [`gsd-atlas: to index ${without.cwd}, run \`gsd-atlas build\` inside it`]);

      const withFolder = makeRig();
      seedClaude(withFolder);
      fs.mkdirSync(path.join(withFolder.cwd, '.git', 'gsd-atlas'), { recursive: true });
      const quiet = await withFolder.run(['init', '--agent', 'claude'], { client: scriptedClient(() => reply).client });
      assert.deepEqual(buildLines(quiet), []);
    });
  }

  it('the linked worktree probe still decides when the Host cannot answer', async () => {
    const rig = makeRig();
    seedClaude(rig);
    const base = path.dirname(rig.cwd);
    const common = path.join(base, 'main', '.git');
    const gitDir = path.join(common, 'worktrees', 'wt1');
    const worktree = path.join(base, 'wt');
    fs.mkdirSync(path.join(common, 'gsd-atlas'), { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');

    const out = await rig.run(['init', '--agent', 'claude'], { cwd: worktree, client: scriptedClient(() => new Error('down')).client });

    assert.deepEqual(buildLines(out), []);
  });

  it('no call is made on a dry run, after a refusal, when nothing was registered, or when no .git entry exists above the working directory', async () => {
    const cases: ReadonlyArray<{ title: string; setup: (rig: Rig) => void; argv: string[] }> = [
      { title: 'dry run', setup: (rig) => { seedClaude(rig); fs.mkdirSync(path.join(rig.cwd, '.git')); }, argv: ['init', '--agent', 'claude', '--dry-run'] },
      { title: 'refusal', setup: (rig) => { seedClaude(rig, '{ not json'); fs.mkdirSync(path.join(rig.cwd, '.git')); }, argv: ['init', '--agent', 'claude'] },
      { title: 'nothing registered', setup: (rig) => { fs.mkdirSync(path.join(rig.cwd, '.git')); }, argv: ['init', '--agent', 'claude'] },
      { title: 'not a repository', setup: (rig) => { seedClaude(rig); }, argv: ['init', '--agent', 'claude'] },
      { title: 'help', setup: (rig) => { fs.mkdirSync(path.join(rig.cwd, '.git')); }, argv: ['--help'] },
      { title: 'a usage error', setup: (rig) => { fs.mkdirSync(path.join(rig.cwd, '.git')); }, argv: ['init', '--agent', 'nobody'] },
    ];
    for (const { title, setup, argv } of cases) {
      const rig = makeRig();
      setup(rig);
      const host = scriptedClient(() => indexStateReply(rig.cwd, false));
      await rig.run(argv, { client: host.client });
      assert.deepEqual(host.requests, [], `${title}: the Host was not contacted`);
    }
  });

  it('two inits and a question at once: each asks the Host once and none blocks the other', async () => {
    const first = makeRig();
    const second = makeRig();
    for (const rig of [first, second]) {
      seedClaude(rig);
      fs.mkdirSync(path.join(rig.cwd, '.git'));
    }
    const hostOne = scriptedClient(() => indexStateReply(first.cwd, false));
    const hostTwo = scriptedClient(() => indexStateReply(second.cwd, true));

    const [one, two] = await Promise.all([
      first.run(['init', '--agent', 'claude'], { client: hostOne.client }),
      second.run(['init', '--agent', 'claude'], { client: hostTwo.client }),
    ]);

    assert.equal(buildLines(one).length, 1);
    assert.equal(buildLines(two).length, 0);
    assert.equal(hostOne.requests.length, 1);
    assert.equal(hostTwo.requests.length, 1);
  });
});

describe('gsd-atlas init and restarts', () => {
  const agents = ['claude', 'cursor', 'codex'] as const;

  function seedAll(rig: Rig): void {
    seedClaude(rig);
    seed(rig, '.cursor/mcp.json', '{}\n');
    seed(rig, '.codex/config.toml', 'model = "o3"\n');
    fs.mkdirSync(path.join(rig.cwd, '.git'));
  }

  for (const argv of [...agents.map((agent) => ['init', '--agent', agent]), ['init']]) {
    it(`no restart claim: \`${argv.join(' ')}\` prints no restart or reload instruction in stderr or the envelope`, async () => {
      const rig = makeRig();
      seedAll(rig);

      const out = await rig.run(argv);

      assert.equal(out.code, 0);
      assert.doesNotMatch(out.stderr.join(''), /restart|reload/i);
      assert.doesNotMatch(out.stdout.join(''), /restart|reload/i);
      assert.ok(out.stderr.join('').includes('gsd-atlas build'), 'the build hint is still there, so the stderr check had something to check');
    });
  }
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

const CURSOR_ENTRY = { type: 'stdio', command: NODE, args: [ENTRY] };

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

  it('entry without type is updated: an entry written by an earlier init gets type stdio, the backup keeps the original', async () => {
    const rig = makeRig();
    const original = `${JSON.stringify({ mcpServers: { other: { command: 'x' }, 'gsd-atlas': { command: NODE, args: [ENTRY] } }, extra: true }, null, 2)}\n`;
    const file = seed(rig, '.cursor/mcp.json', original);

    const out = await rig.run(['init', '--agent', 'cursor']);

    assert.equal(out.code, 0);
    assert.deepEqual(out.envelope().data.hosts, [{ agent: 'cursor', file, action: 'updated' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      mcpServers: { other: { command: 'x' }, 'gsd-atlas': CURSOR_ENTRY },
      extra: true,
    });
    assert.equal(fs.readFileSync(`${file}${BACKUP}`, 'utf8'), original);
    assert.equal((await rig.run(['init', '--agent', 'cursor'])).envelope().data.hosts[0]!.action, 'unchanged');
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

  it('writes no type key for Codex: its transport is inferred from command', async () => {
    const rig = makeRig();
    fs.mkdirSync(path.join(rig.home, '.codex'));
    await rig.run(['init', '--agent', 'codex']);
    const text = fs.readFileSync(path.join(rig.home, '.codex', 'config.toml'), 'utf8');
    assert.ok(!/\btype\b/.test(text), text);
    assert.ok(text.includes('command = '));
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

  describe('block end is the next real table header', () => {
    const head = ['model = "o3"', ''];
    const tail = ['[next]', 'key = 1', ''];

    async function replaced(oldBlock: readonly string[]): Promise<{ out: Outcome; text: string }> {
      const rig = makeRig();
      const file = seed(rig, '.codex/config.toml', [...head, '[mcp_servers.gsd-atlas]', ...oldBlock, ...tail].join('\n'));
      const out = await rig.run(['init', '--agent', 'codex']);
      return { out, text: fs.readFileSync(file, 'utf8') };
    }

    // The table is edited, not replaced (plan 02-44): only the command and args statements change, so a key of the
    // user's, here a multi-line `notes` or `doc`, stays where it is and still does not end the table early.
    const [headerLine, commandLine, argsLine] = table() as [string, string, string];
    const expectedWith = (...kept: string[]): string => [...head, headerLine, commandLine, argsLine, ...kept, '', ...tail].join('\n');

    it('multi-line array in our table whose continuation lines start with [', async () => {
      const { out, text } = await replaced(['command = "/old/node"', 'args = ["/old/entry.js"]', 'notes = [', '  [1, 2],', '  [3]', ']', '']);
      assert.equal(out.code, 0);
      assert.equal(text, expectedWith('notes = [', '  [1, 2],', '  [3]', ']'));
    });

    it('multi-line basic string in our table with a line [not a table]', async () => {
      const { out, text } = await replaced(['command = "/old/node"', 'doc = """', '[not a table]', '"""', 'args = ["/old/entry.js"]', '']);
      assert.equal(out.code, 0);
      assert.equal(text, [...head, headerLine, commandLine, 'doc = """', '[not a table]', '"""', argsLine, '', ...tail].join('\n'));
    });

    it('multi-line literal string in our table with a line [not a table]', async () => {
      const { out, text } = await replaced(['command = "/old/node"', "doc = '''", '[not a table]', "'''", 'args = ["/old/entry.js"]', '']);
      assert.equal(out.code, 0);
      assert.equal(text, [...head, headerLine, commandLine, "doc = '''", '[not a table]', "'''", argsLine, '', ...tail].join('\n'));
    });

    it('a string line equal to our header in another table is not our table: the block is appended and the string is untouched', async () => {
      const rig = makeRig();
      const before = ['[other]', 'text = """', '[mcp_servers.gsd-atlas]', 'command = "x"', '"""', ''].join('\n');
      const file = seed(rig, '.codex/config.toml', before);

      const out = await rig.run(['init', '--agent', 'codex']);

      assert.equal(out.code, 0);
      assert.equal(out.envelope().data.hosts[0]!.action, 'updated');
      assert.equal(fs.readFileSync(file, 'utf8'), `${before}\n${table().join('\n')}\n`);
    });

    it('a line that is just [ inside a multi-line array of another table is not refused', async () => {
      const rig = makeRig();
      const before = ['[other]', 'list = [', '[', '  1,', '],', ']', ''].join('\n');
      const file = seed(rig, '.codex/config.toml', before);

      const out = await rig.run(['init', '--agent', 'codex']);

      assert.equal(out.code, 0);
      assert.equal(out.envelope().data.hosts[0]!.action, 'updated');
      assert.equal(fs.readFileSync(file, 'utf8'), `${before}\n${table().join('\n')}\n`);
    });

    it('a real unclosed header at depth zero is still refused with its line number', async () => {
      const rig = makeRig();
      const bytes = Buffer.from('list = [\n[1],\n]\n[broken\nkey = 1\n');
      const file = seed(rig, '.codex/config.toml', bytes);

      const out = await rig.run(['init', '--agent', 'codex']);

      assert.equal(out.code, 2);
      assert.match(out.envelope().data.hosts[0]!.reason ?? '', /line 4/);
      assert.deepEqual(fs.readFileSync(file), bytes);
    });

    it('CRLF files keep CRLF and the bytes outside the block are identical', async () => {
      const rig = makeRig();
      const lines = [...head, '[mcp_servers.gsd-atlas]', 'command = "/old"', 'notes = [', '  [1],', ']', '', ...tail];
      const file = seed(rig, '.codex/config.toml', lines.join('\r\n'));

      await rig.run(['init', '--agent', 'codex']);

      // `args` was missing, so it is inserted directly after `command`; `notes` and the blank line stay.
      assert.equal(fs.readFileSync(file, 'utf8'), [...head, ...table(), 'notes = [', '  [1],', ']', '', ...tail].join('\r\n'));
    });
  });

  describe('every spelling of our table is our table, and only command and args are managed (plan 02-44)', () => {
    const stale = ['command = "/old/node"', 'args = ["/old/entry.js"]'];
    const [, commandLine, argsLine] = table() as [string, string, string];
    const countOf = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

    const spellings: ReadonlyArray<{ title: string; header: string }> = [
      { title: 'header with a comment', header: '[mcp_servers.gsd-atlas] # note' },
      { title: 'header with spaces', header: '[ mcp_servers.gsd-atlas ]' },
      { title: 'header with spaces around the dot', header: '[mcp_servers . gsd-atlas]' },
      { title: 'quoted key header', header: '[mcp_servers."gsd-atlas"]' },
      { title: 'quoted key header (literal string)', header: "[mcp_servers.'gsd-atlas']" },
    ];
    for (const { title, header } of spellings) {
      it(`${title}: ${header} is updated in place, no second table is appended, the header line is kept and a second run is unchanged`, async () => {
        const rig = makeRig();
        const before = ['model = "o3"', '', header, ...stale, '', '[next]', 'k = 1', ''].join('\n');
        const file = seed(rig, '.codex/config.toml', before);

        const first = await rig.run(['init', '--agent', 'codex']);

        assert.equal(first.code, 0);
        assert.equal(first.envelope().data.hosts[0]!.action, 'updated');
        const after = fs.readFileSync(file, 'utf8');
        assert.equal(after, ['model = "o3"', '', header, commandLine, argsLine, '', '[next]', 'k = 1', ''].join('\n'));
        assert.equal(countOf(after, /^\s*\[[^\]]*mcp_servers[^\]]*\]/gm), 1, 'one table for the server');

        const second = await rig.run(['init', '--agent', 'codex']);
        assert.equal(second.envelope().data.hosts[0]!.action, 'unchanged');
        assert.equal(fs.readFileSync(file, 'utf8'), after);
      });
    }

    const unsafe: ReadonlyArray<{ title: string; lines: string[]; line: number }> = [
      { title: 'inline table is refused', lines: ['model = "o3"', '[mcp_servers]', 'gsd-atlas = { command = "x" }', ''], line: 3 },
      { title: 'inline table with a quoted key is refused', lines: ['[mcp_servers]', '"gsd-atlas" = { command = "x" }', ''], line: 2 },
      { title: 'dotted keys are refused', lines: ['model = "o3"', 'mcp_servers.gsd-atlas.command = "x"', ''], line: 2 },
      { title: 'dotted keys under mcp_servers are refused', lines: ['[mcp_servers]', 'gsd-atlas.command = "x"', ''], line: 2 },
      { title: 'mcp_servers as an inline table is refused', lines: ['mcp_servers = { other = { command = "o" } }', ''], line: 1 },
      { title: 'a table defined twice is refused', lines: ['[mcp_servers.gsd-atlas]', 'command = "a"', '', '[ mcp_servers.gsd-atlas ]', 'args = []', ''], line: 4 },
      { title: 'an array of tables is refused', lines: ['[[mcp_servers.gsd-atlas]]', 'command = "a"', ''], line: 1 },
    ];
    for (const { title, lines, line } of unsafe) {
      it(`${title}: refused with line ${String(line)} and "edit it by hand", the file is untouched`, async () => {
        const rig = makeRig();
        const bytes = Buffer.from(lines.join('\n'));
        const file = seed(rig, '.codex/config.toml', bytes);

        const out = await rig.run(['init', '--agent', 'codex']);

        assert.equal(out.code, 2);
        const host = out.envelope().data.hosts[0]!;
        assert.equal(host.action, 'refused');
        assert.match(host.reason ?? '', new RegExp(`line ${String(line)}\\b`));
        assert.match(host.reason ?? '', /edit it by hand/);
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.toml']);
      });
    }

    it('comment above the next header: the comment lines directly above a header, with no blank line, stay in place', async () => {
      const rig = makeRig();
      const file = seed(rig, '.codex/config.toml', ['[mcp_servers.gsd-atlas]', ...stale, '# about next', '# and more', '[next]', 'k = 1', ''].join('\n'));

      await rig.run(['init', '--agent', 'codex']);

      assert.equal(fs.readFileSync(file, 'utf8'), ['[mcp_servers.gsd-atlas]', commandLine, argsLine, '# about next', '# and more', '[next]', 'k = 1', ''].join('\n'));
    });

    it('user keys are preserved: keys, comments, blank lines and sub-tables stay byte for byte and in order, only command and args change', async () => {
      const rig = makeRig();
      const before = [
        'model = "o3"',
        '',
        '[mcp_servers.gsd-atlas]',
        'startup_timeout_sec = 30',
        'command = "/old/node"',
        'env = { A = "1" }',
        '# tuned by hand',
        '',
        'args = ["/old/entry.js", "--x"]',
        'tool_timeout_sec = 90',
        '',
        '[mcp_servers.gsd-atlas.env]',
        'B = "2"',
        '',
      ];
      const file = seed(rig, '.codex/config.toml', before.join('\n'));

      const out = await rig.run(['init', '--agent', 'codex']);

      assert.equal(out.code, 0);
      const expected = [...before];
      expected[4] = commandLine;
      expected[8] = argsLine;
      assert.equal(fs.readFileSync(file, 'utf8'), expected.join('\n'));
    });

    it('multi-line args replaced whole: the array, its inner comment and its closing bracket become one current line', async () => {
      const rig = makeRig();
      const file = seed(
        rig,
        '.codex/config.toml',
        ['[mcp_servers.gsd-atlas]', 'command = "/old/node"', 'args = [', '  "/old/entry.js", # inner', '  "--x",', ']', 'after = 1', '[next]', ''].join('\n'),
      );

      await rig.run(['init', '--agent', 'codex']);

      assert.equal(fs.readFileSync(file, 'utf8'), ['[mcp_servers.gsd-atlas]', commandLine, argsLine, 'after = 1', '[next]', ''].join('\n'));
    });

    const shapes: ReadonlyArray<{ title: string; text: string; expected: string }> = [
      { title: 'an empty table', text: '[mcp_servers.gsd-atlas]\n\n[next]\nk = 1\n', expected: `[mcp_servers.gsd-atlas]\n${commandLine}\n${argsLine}\n\n[next]\nk = 1\n` },
      { title: 'a table with only args', text: `[mcp_servers.gsd-atlas]\nargs = ["/old"]\n`, expected: `[mcp_servers.gsd-atlas]\n${commandLine}\n${argsLine}\n` },
      { title: 'a table with command after args', text: `[mcp_servers.gsd-atlas]\nargs = ["/old"]\ncommand = "/old/node"\n`, expected: `[mcp_servers.gsd-atlas]\n${argsLine}\n${commandLine}\n` },
      { title: 'a table with only command', text: `[mcp_servers.gsd-atlas]\ncommand = "/old/node"\nenv = { A = "1" }\n`, expected: `[mcp_servers.gsd-atlas]\n${commandLine}\n${argsLine}\nenv = { A = "1" }\n` },
      { title: 'a table last in the file with no final newline', text: 'model = "o3"\n[mcp_servers.gsd-atlas]\ncommand = "/old/node"', expected: `model = "o3"\n[mcp_servers.gsd-atlas]\n${commandLine}\n${argsLine}` },
      { title: 'a header that is the whole file with no final newline', text: '[mcp_servers.gsd-atlas]', expected: `[mcp_servers.gsd-atlas]\n${commandLine}\n${argsLine}` },
      { title: 'a file that is only the table', text: `[mcp_servers.gsd-atlas]\n${stale.join('\n')}\n`, expected: `[mcp_servers.gsd-atlas]\n${commandLine}\n${argsLine}\n` },
    ];
    for (const { title, text, expected } of shapes) {
      it(`${title} ends with exactly one command and one args`, async () => {
        const rig = makeRig();
        const file = seed(rig, '.codex/config.toml', text);

        const out = await rig.run(['init', '--agent', 'codex']);

        assert.equal(out.code, 0, out.stderr.join(''));
        const after = fs.readFileSync(file, 'utf8');
        assert.equal(after, expected);
        assert.equal(countOf(after, /^command = /gm), 1);
        assert.equal(countOf(after, /^args = /gm), 1);
        assert.equal((await rig.run(['init', '--agent', 'codex'])).envelope().data.hosts[0]!.action, 'unchanged');
      });
    }

    it('url conflict is refused: Codex rejects a server with both a command and a url, the message names the line, the file is untouched', async () => {
      const rig = makeRig();
      const bytes = Buffer.from(['[mcp_servers.gsd-atlas]', 'url = "https://example.test/mcp"', ''].join('\n'));
      const file = seed(rig, '.codex/config.toml', bytes);

      const out = await rig.run(['init', '--agent', 'codex']);

      assert.equal(out.code, 2);
      const reason = out.envelope().data.hosts[0]!.reason ?? '';
      assert.match(reason, /line 2\b/);
      assert.match(reason, /url/);
      assert.match(reason, /edit it by hand/);
      assert.deepEqual(fs.readFileSync(file), bytes);
    });

    const repeated: ReadonlyArray<{ title: string; lines: string[]; line: number }> = [
      { title: 'command written twice', lines: ['[mcp_servers.gsd-atlas]', 'command = "a"', 'command = "b"', ''], line: 3 },
      { title: 'args written twice', lines: ['[mcp_servers.gsd-atlas]', 'args = []', 'args = ["x"]', ''], line: 3 },
      { title: 'args written as a dotted key', lines: ['[mcp_servers.gsd-atlas]', 'args.0 = "x"', ''], line: 2 },
      { title: 'command written as a dotted key', lines: ['[mcp_servers.gsd-atlas]', 'command.path = "x"', ''], line: 2 },
    ];
    for (const { title, lines, line } of repeated) {
      it(`${title} is refused naming line ${String(line)}`, async () => {
        const rig = makeRig();
        const bytes = Buffer.from(lines.join('\n'));
        const file = seed(rig, '.codex/config.toml', bytes);

        const out = await rig.run(['init', '--agent', 'codex']);

        assert.equal(out.code, 2);
        assert.match(out.envelope().data.hosts[0]!.reason ?? '', new RegExp(`line ${String(line)}\\b`));
        assert.deepEqual(fs.readFileSync(file), bytes);
      });
    }

    it('crlf insertions: every inserted or replaced line ends with CRLF, no bare LF appears, and a LF file gains no CR', async () => {
      const crlf = makeRig();
      const crlfFile = seed(crlf, '.codex/config.toml', ['model = "o3"', '[mcp_servers.gsd-atlas]', 'startup_timeout_sec = 30', '# tail', '[next]', 'k = 1', ''].join('\r\n'));
      await crlf.run(['init', '--agent', 'codex']);
      const crlfText = fs.readFileSync(crlfFile, 'utf8');
      assert.equal(crlfText, ['model = "o3"', '[mcp_servers.gsd-atlas]', commandLine, argsLine, 'startup_timeout_sec = 30', '# tail', '[next]', 'k = 1', ''].join('\r\n'));
      assert.ok(!/(?<!\r)\n/.test(crlfText), 'no bare LF');

      const crlfNoFinal = makeRig();
      const noFinalFile = seed(crlfNoFinal, '.codex/config.toml', ['x = 1', '[mcp_servers.gsd-atlas]'].join('\r\n'));
      await crlfNoFinal.run(['init', '--agent', 'codex']);
      assert.equal(fs.readFileSync(noFinalFile, 'utf8'), ['x = 1', '[mcp_servers.gsd-atlas]', commandLine, argsLine].join('\r\n'));

      const lf = makeRig();
      const lfFile = seed(lf, '.codex/config.toml', ['[mcp_servers.gsd-atlas]', 'startup_timeout_sec = 30', ''].join('\n'));
      await lf.run(['init', '--agent', 'codex']);
      assert.ok(!fs.readFileSync(lfFile, 'utf8').includes('\r'));
    });

    it('an unrelated table is never touched, and a table named like ours under another parent is not ours', async () => {
      const rig = makeRig();
      const before = ['[other.gsd-atlas]', 'command = "keep"', '', '[mcp_servers.gsd-atlas-extra]', 'command = "keep too"', ''].join('\n');
      const file = seed(rig, '.codex/config.toml', before);

      await rig.run(['init', '--agent', 'codex']);

      assert.equal(fs.readFileSync(file, 'utf8'), `${before}\n${table().join('\n')}\n`);
    });
  });
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
