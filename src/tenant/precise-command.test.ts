/**
 * The approved `precise.command` gate (plan 03-29, SEC-02, OQ5): a language module may declare a command; `maintain resolve`
 * runs it only for the exact command a person approved for this repository, through the CommandRunner, and reports its exit
 * status and nothing it printed. Real Hosts over temporary git repositories, the real runner, a real module with a real
 * grammar (the toy module's), and real scripts as the commands.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { COMMAND_CODES, allowAll, commandHash, compilerWorkerShape, createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import type { CommandRunner, CommandSpec, RecordedSpec, UserPermissions } from '../command-runner/index.ts';
import { PROTOCOL_VERSION, diagnostic } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import { addAllowEntry, createHost, loadUserConfig, needsApprovalFrom, permissionsFor } from '../host/index.ts';
import type { Host, HostOrigin } from '../host/index.ts';
import { createManualEventSource } from '../indexer/index.ts';
import { resolveWorkerPath } from '../precise-resolver/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import type { CommandReport, TenantTuning } from './index.ts';
import { runApprovedPreciseCommand } from './precise-command.ts';

const TOY = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');
const MODULES = path.resolve(import.meta.dirname, '..', '..', 'modules');
const setupRunner = createRealRunner({ decide: allowAll });

const OUT = 'MARKER-STDOUT-5c1e8f';
const ERR = 'MARKER-STDERR-5c1e8f';

/** Writes `INDEXED` in the working directory (the repository root), prints a marker to each stream and exits 0. */
const OK_SCRIPT = `import fs from 'node:fs';\nfs.writeFileSync('INDEXED', 'yes');\nprocess.stdout.write('${OUT}\\n');\nprocess.stderr.write('${ERR}\\n');\n`;
/** The same markers, and exit status 3. */
const FAIL_SCRIPT = `process.stdout.write('${OUT}\\n');\nprocess.stderr.write('${ERR}\\n');\nprocess.exit(3);\n`;
/** The same markers, then it waits far longer than any limit. */
const SLOW_SCRIPT = `process.stdout.write('${OUT}\\n');\nprocess.stderr.write('${ERR}\\n');\nsetTimeout(() => {}, 120000);\n`;

const FILES: Readonly<Record<string, string>> = {
  'a.idx': 'fn main {\n  boot();\n}\nfn boot {\n}\n',
  'README.md': '# repository with a module command\n',
  'tools/index.mjs': OK_SCRIPT,
  'tools/fail.mjs': FAIL_SCRIPT,
  'tools/slow.mjs': SLOW_SCRIPT,
};

function manifest(command: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    name: 'idx',
    version: '0.1.0',
    extensions: ['.idx'],
    grammar: { wasm: 'grammar.wasm', lock: 'grammar.lock' },
    queries: { tags: 'queries/tags.scm', refs: 'queries/refs.scm', imports: 'queries/imports.scm' },
    tiers: ['grammar', 'precise'],
    parseBudget: 0.005,
    precise: { command },
  });
}

interface CommandWorld {
  readonly host: Host;
  readonly repo: TempGitRepo;
  readonly dir: string;
  readonly storeDir: string;
  readonly recorder: ReturnType<typeof createRecordingRunner>;
  /** Specs the runner was asked to start for the module's command (not git). */
  commandStarts(): RecordedSpec[];
  ask(kind: string, args?: Record<string, unknown>): Promise<Envelope>;
  resolve(): Promise<Envelope>;
  /** Approve exactly `command` for this repository the way `gsd-atlas allow` records it, for a Host composed afterwards. */
  setManifest(command: readonly string[]): void;
}

interface WorldOptions {
  readonly command: readonly string[];
  /** Approve this exact command before the Host is composed. Default: none. */
  readonly approve?: readonly string[];
  readonly origin?: HostOrigin;
  readonly allowBuild?: boolean;
  readonly tuning?: Partial<TenantTuning>;
}

async function makeCommandWorld(t: TestContext, options: WorldOptions): Promise<CommandWorld> {
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: FILES } });
  const tmp = makeTempDir();
  const engine = createGrammarEngine();
  const dir = realPath(repo.dir);
  const moduleDir = path.join(dir, '.gsd-atlas', 'languages', 'idx');
  fs.cpSync(TOY, moduleDir, { recursive: true, filter: (from) => !path.basename(from).startsWith('fixtures') });
  fs.writeFileSync(path.join(moduleDir, 'atlas-lang.json'), manifest(options.command));

  const userDir = path.join(tmp.path, 'user');
  if (options.approve !== undefined) {
    const [executable, ...args] = options.approve as [string, ...string[]];
    const sha256 = commandHash({ executable, args, cwd: '.' }, dir);
    assert.ok(sha256 !== null);
    const added = addAllowEntry(userDir, { repo: dir, executable, sha256 });
    assert.equal(added.ok, true, JSON.stringify(added));
  }
  const loaded = loadUserConfig(userDir, {});
  const origin = options.origin ?? 'cli';
  const allowBuild = options.allowBuild === true;
  const user: UserPermissions | undefined = permissionsFor(origin, allowBuild, loaded.config.permissions);
  const real = createRealRunner({ ...(user === undefined ? {} : { user }) });
  const recorder = createRecordingRunner({ ...(user === undefined ? {} : { user }), delegate: real });
  const host = createHost({
    roots: { repoRoot: dir, userDir, builtinDir: null, npmRoots: [] },
    engine,
    runner: recorder,
    cwd: dir,
    userDir,
    cacheRoot: path.join(tmp.path, 'cache'),
    gitEnv: repo.envOverlay,
    eventSource: () => createManualEventSource().source,
    origin,
    allowBuild,
    config: loaded.config,
    ...(options.tuning === undefined ? {} : { tuning: options.tuning }),
  });
  t.after(async () => {
    await host.close();
    await engine.dispose();
    tmp.cleanup();
    repo.cleanup();
  });
  const ask = (kind: string, args: Record<string, unknown> = {}): Promise<Envelope> => host.handle({ protocol: PROTOCOL_VERSION, kind, args: { repo: dir, ...args } });
  const world: CommandWorld = {
    host,
    repo,
    dir,
    storeDir: path.join(dir, '.git', 'gsd-atlas'),
    recorder,
    commandStarts: () => recorder.starts.filter((spec) => spec.executable !== 'git'),
    ask,
    resolve: () => ask('maintain', { task: 'resolve' }),
    setManifest: (command) => fs.writeFileSync(path.join(moduleDir, 'atlas-lang.json'), manifest(command)),
  };
  const built = await ask('build');
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  return world;
}

const reportOf = (envelope: Envelope): CommandReport | undefined =>
  (envelope.data as { tasks: Record<string, { precise?: { command?: CommandReport } }> }).tasks['resolve']?.precise?.command;

const APPROVED_OK = [process.execPath, 'tools/index.mjs'] as const;

describe('the approved precise.command gate (SEC-02, OQ5)', () => {
  it('unapproved is not started: no process, the fixed needs_approval answer, and nothing the command would write', async (t) => {
    const world = await makeCommandWorld(t, { command: APPROVED_OK });
    const reply = await world.resolve();
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const command = reportOf(reply);
    assert.deepStrictEqual(
      { ran: command?.ran, ok: command?.ok, needsApproval: command?.needsApproval, exitCode: command?.exitCode, timedOut: command?.timedOut },
      { ran: false, ok: false, needsApproval: true, exitCode: null, timedOut: false },
    );
    assert.deepStrictEqual(reply.degraded, ['needs_approval']);
    const note = reply.diagnostics.find((entry) => entry.code === 'needs_approval');
    assert.ok(note !== undefined, JSON.stringify(reply.diagnostics));
    assert.equal(note.message.includes(process.execPath), false, 'the fixed text names no argument');
    assert.equal(note.message.includes('index.mjs'), false);
    assert.equal(world.commandStarts().length, 0, 'the runner was not asked to start it');
    assert.equal(world.recorder.denials.some((spec) => spec.executable !== 'git'), false, 'it was not even attempted');
    assert.equal(fs.existsSync(path.join(world.dir, 'INDEXED')), false);
  });

  it('approved runs and reports exit status: one start through the runner by the user rule, only status fields reported', async (t) => {
    const world = await makeCommandWorld(t, { command: APPROVED_OK, approve: APPROVED_OK });
    const reply = await world.resolve();
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    const command = reportOf(reply);
    assert.ok(command !== undefined);
    assert.deepStrictEqual(Object.keys(command).sort(), ['exitCode', 'needsApproval', 'ms', 'ok', 'ran', 'signal', 'timedOut'].sort(), 'no output field');
    assert.deepStrictEqual(
      { ran: command.ran, ok: command.ok, exitCode: command.exitCode, signal: command.signal, timedOut: command.timedOut, needsApproval: command.needsApproval },
      { ran: true, ok: true, exitCode: 0, signal: null, timedOut: false, needsApproval: false },
    );
    assert.ok(Number.isFinite(command.ms) && command.ms >= 0);
    assert.equal(reply.degraded, undefined);
    assert.equal(reply.diagnostics.some((entry) => entry.code === 'needs_approval'), false);
    assert.equal(fs.readFileSync(path.join(world.dir, 'INDEXED'), 'utf8'), 'yes', 'the command ran in the repository root');
    const [started, ...more] = world.commandStarts();
    assert.equal(more.length, 0, 'one spec');
    assert.equal(started?.executable, process.execPath);
    assert.deepStrictEqual(started?.args, ['tools/index.mjs']);
    assert.equal(started?.cwd, world.dir);
  });

  it('approved runs and reports exit status: a command that exits 3 is ran and not ok, with its exit code', async (t) => {
    const failing = [process.execPath, 'tools/fail.mjs'] as const;
    const world = await makeCommandWorld(t, { command: failing, approve: failing });
    const command = reportOf(await world.resolve());
    assert.deepStrictEqual(
      { ran: command?.ran, ok: command?.ok, exitCode: command?.exitCode, timedOut: command?.timedOut, needsApproval: command?.needsApproval },
      { ran: true, ok: false, exitCode: 3, timedOut: false, needsApproval: false },
    );
  });

  it('changed argument needs approval again: the hash binds the exact command, so a manifest edit after the approval is not started', async (t) => {
    const world = await makeCommandWorld(t, { command: APPROVED_OK, approve: APPROVED_OK });
    world.setManifest([process.execPath, 'tools/index.mjs', '--other']);
    const reply = await world.resolve();
    assert.equal(reportOf(reply)?.needsApproval, true);
    assert.equal(reportOf(reply)?.ran, false);
    assert.deepStrictEqual(reply.degraded, ['needs_approval']);
    assert.equal(world.commandStarts().length, 0);
    assert.equal(fs.existsSync(path.join(world.dir, 'INDEXED')), false);
    // A repository file can neither add an approval nor change what an approval binds: the same command with the old
    // arguments, back in the manifest, is approved again.
    world.setManifest([...APPROVED_OK]);
    assert.equal(reportOf(await world.resolve())?.ran, true);
  });

  it('mcp origin without allow-build: the same approved command is not started, and the report says needs_approval', async (t) => {
    const world = await makeCommandWorld(t, { command: APPROVED_OK, approve: APPROVED_OK, origin: 'mcp', allowBuild: false });
    const reply = await world.resolve();
    assert.equal(reportOf(reply)?.needsApproval, true);
    assert.equal(reportOf(reply)?.ran, false);
    assert.deepStrictEqual(reply.degraded, ['needs_approval']);
    assert.equal(world.commandStarts().length, 0);
    assert.equal(fs.existsSync(path.join(world.dir, 'INDEXED')), false);
  });

  it('mcp origin with allow-build: the approved command runs', async (t) => {
    const world = await makeCommandWorld(t, { command: APPROVED_OK, approve: APPROVED_OK, origin: 'mcp', allowBuild: true });
    const reply = await world.resolve();
    assert.equal(reportOf(reply)?.ran, true);
    assert.equal(reportOf(reply)?.ok, true);
    assert.equal(world.commandStarts().length, 1);
    assert.equal(fs.existsSync(path.join(world.dir, 'INDEXED')), true);
  });

  it('timeout is killed: a command past the approved limit is killed and reported timedOut', async (t) => {
    const slow = [process.execPath, 'tools/slow.mjs'] as const;
    const world = await makeCommandWorld(t, { command: slow, approve: slow, tuning: { resolveBoundMs: 400 } });
    const startedAt = Date.now();
    const command = reportOf(await world.resolve());
    assert.ok(Date.now() - startedAt < 20_000, 'the command did not run for its two minutes');
    assert.deepStrictEqual(
      { ran: command?.ran, ok: command?.ok, timedOut: command?.timedOut, needsApproval: command?.needsApproval, exitCode: command?.exitCode },
      { ran: true, ok: false, timedOut: true, needsApproval: false, exitCode: null },
    );
    assert.ok(command !== undefined && command.ms >= 300 && command.ms < 15_000, String(command?.ms));
  });

  it('output never leaves: what the command printed is in no envelope, no recorder file, no database and no spec', async (t) => {
    for (const [label, command, tuning] of [
      ['ok', APPROVED_OK, {}],
      ['fail', [process.execPath, 'tools/fail.mjs'], {}],
      ['slow', [process.execPath, 'tools/slow.mjs'], { resolveBoundMs: 400 }],
    ] as const) {
      const world = await makeCommandWorld(t, { command, approve: command, tuning });
      const reply = await world.resolve();
      const status = await world.ask('status');
      const seen: string[] = [JSON.stringify(reply), JSON.stringify(status), JSON.stringify(world.recorder.starts), JSON.stringify(world.recorder.denials)];
      // Every file the store directory holds: the databases, the flight recorder, the metrics.
      const files: string[] = [];
      const walk = (folder: string): void => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          const full = path.join(folder, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push(full);
        }
      };
      walk(world.storeDir);
      assert.ok(files.some((file) => file.endsWith('facts.db')), 'the store was inspected');
      for (const text of seen) assert.equal(text.includes(OUT) || text.includes(ERR), false, `${label}: an envelope or a spec holds the output`);
      for (const file of files) {
        const bytes = fs.readFileSync(file);
        assert.equal(bytes.includes(OUT) || bytes.includes(ERR), false, `${label}: ${path.relative(world.storeDir, file)} holds the output`);
      }
    }
  });

  it('the built-in TypeScript tier is unaffected: the Host starts git and the worker, no command, and the report carries none', async (t) => {
    const repo = await createTempGitRepo({
      runner: setupRunner,
      world: {
        committed: {
          'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'es2022' }, include: ['src'] }),
          'src/lib.ts': 'export function compute(n: number): number {\n  return n + 1;\n}\n',
          'src/user.ts': "import { compute } from './lib';\nexport const answer = compute(1);\n",
        },
      },
    });
    const tmp = makeTempDir();
    const engine = createGrammarEngine();
    const shape = compilerWorkerShape({ execPath: process.execPath, workerPath: resolveWorkerPath() });
    // A runner that notes every spec and passes both `run` and `stream` on to the real one (a streamed worker must really run).
    const inner = createRealRunner({ builtinShapes: [shape] });
    const specs: CommandSpec[] = [];
    const recorder: CommandRunner & { readonly starts: readonly CommandSpec[] } = {
      starts: specs,
      run: (spec, ctx) => (specs.push(spec), inner.run(spec, ctx)),
      stream: (spec, ctx) => (specs.push(spec), inner.stream(spec, ctx)),
    };
    const host = createHost({
      roots: { repoRoot: repo.dir, userDir: path.join(tmp.path, 'user'), builtinDir: MODULES, npmRoots: [] },
      engine,
      runner: recorder,
      cwd: repo.dir,
      userDir: path.join(tmp.path, 'user'),
      cacheRoot: path.join(tmp.path, 'cache'),
      gitEnv: repo.envOverlay,
      eventSource: () => createManualEventSource().source,
      metrics: false,
      knownAdapters: ['typescript'],
    });
    t.after(async () => {
      await host.close();
      await engine.dispose();
      tmp.cleanup();
      repo.cleanup();
    });
    const ask = (kind: string, args: Record<string, unknown> = {}): Promise<Envelope> => host.handle({ protocol: PROTOCOL_VERSION, kind, args });
    assert.equal((await ask('build')).ok, true);
    const reply = await ask('maintain', { task: 'resolve' });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.equal(reportOf(reply), undefined, 'no command report for a tier that uses an adapter');
    assert.equal(reply.degraded?.includes('needs_approval') ?? false, false);
    assert.ok(recorder.starts.some((spec) => spec.builtinId === 'typescript-resolver'), 'the worker really ran');
    for (const spec of recorder.starts) assert.ok(spec.executable === 'git' || spec.builtinId === 'typescript-resolver', `unexpected start: ${spec.executable} ${spec.args.join(' ')}`);
  });

  it('the helper reads no output of the command: its source names neither stream of a result, and maps a refusal through needsApprovalFrom', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'precise-command.ts'), 'utf8');
    assert.ok(source.includes('needsApprovalFrom'));
    assert.equal(source.includes('.stdout'), false);
    assert.equal(source.includes('.stderr'), false);
  });
});

describe('runApprovedPreciseCommand (the helper)', () => {
  const deps = (runner: CommandRunner) => ({
    runner,
    repoDir: '/repo',
    command: ['tool', '--flag'] as const,
    timeoutMs: 1234,
    now: () => 0,
    approved: () => true,
    needsApprovalFrom,
  });

  it('a runner that denies at the last moment is a missing approval, mapped by needsApprovalFrom', async () => {
    const runner = createRecordingRunner({ decide: () => ({ allowed: false, diagnostic: diagnostic(COMMAND_CODES.denied, 'warning', 'denied') }) });
    const outcome = await runApprovedPreciseCommand(deps(runner));
    assert.equal(outcome.report.needsApproval, true);
    assert.equal(outcome.report.ran, false);
    assert.equal(outcome.refusal?.degraded, 'needs_approval');
  });

  it('a command that cannot be started is neither run nor a missing approval', async () => {
    const runner: CommandRunner = {
      run: () =>
        Promise.resolve({
          ok: false,
          exitCode: null,
          signal: null,
          stdout: new Uint8Array(0),
          stderr: new Uint8Array(0),
          truncated: false,
          timedOut: false,
          spawnError: diagnostic(COMMAND_CODES.spawnFailed, 'error', 'no such file'),
          diagnostics: [],
        }),
      stream: () => {
        throw new Error('not used');
      },
    };
    const outcome = await runApprovedPreciseCommand(deps(runner));
    assert.deepStrictEqual({ ran: outcome.report.ran, needsApproval: outcome.report.needsApproval, ok: outcome.report.ok }, { ran: false, needsApproval: false, ok: false });
    assert.equal(outcome.refusal, undefined);
  });

  it('asks the runner for exactly the manifest argv in the repository root, with the limit and the repository as context', async () => {
    const seen: Array<{ executable: string; args: readonly string[]; cwd: string | undefined; timeoutMs: number | undefined; repo: string | undefined }> = [];
    const runner = createRecordingRunner({
      decide: () => ({ allowed: true, via: 'user' }),
      respond: (spec, ctx) => {
        seen.push({ executable: spec.executable, args: spec.args, cwd: spec.cwd, timeoutMs: spec.timeoutMs, repo: ctx.repo });
        return { exitCode: 0, stdout: 'ignored', stderr: 'ignored' };
      },
    });
    const outcome = await runApprovedPreciseCommand(deps(runner));
    assert.deepStrictEqual(seen, [{ executable: 'tool', args: ['--flag'], cwd: '/repo', timeoutMs: 1234, repo: '/repo' }]);
    assert.equal(outcome.report.ok, true);
    assert.equal(outcome.refusal, undefined);
  });

  it('a command that is not approved is not given to the runner at all', async () => {
    const runner = createRecordingRunner({ decide: () => ({ allowed: true, via: 'user' }) });
    const outcome = await runApprovedPreciseCommand({ ...deps(runner), approved: () => false });
    assert.equal(outcome.report.needsApproval, true);
    assert.equal(runner.starts.length + runner.denials.length, 0);
    assert.equal(outcome.refusal?.degraded, 'needs_approval');
  });
});
