/**
 * Process-level proof of `gsd-atlas lang test` (FND-11, D-02): the real bin is started through the
 * real CommandRunner, so argv parsing, the CLI adapter, the in-process HostClient, the Grammar
 * Engine, golden comparison, stdout, stderr and the exit code are all exercised together.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { makeTempDir } from '../test-kit/index.ts';

const TOY = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');
const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'gsd-atlas.ts');

const runner = createRealRunner({ decide: allowAll });
const temp = makeTempDir();
after(() => {
  temp.cleanup();
});

interface Diag {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
}
interface Outcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: { readonly schema: string; readonly ok: boolean; readonly data: unknown; readonly diagnostics: Diag[] };
}

async function spawnAtlas(args: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runner.run({ executable: process.execPath, args: [BIN, ...args] });
  assert.equal(result.spawnError, undefined, 'the bin must start');
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}

async function atlas(args: readonly string[]): Promise<Outcome> {
  const { stdout, stderr, exitCode } = await spawnAtlas(args);
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, `stdout carries exactly one JSON envelope, got: ${stdout}`);
  assert.ok(stdout.endsWith('\n'));
  return { exitCode, stdout, stderr, envelope: JSON.parse(lines[0]!) as Outcome['envelope'] };
}

let counter = 0;
/** A copy of the toy module (in a folder name containing a space) limited to the given fixtures. */
function copyToy(only?: readonly string[]): string {
  counter += 1;
  const dest = path.join(temp.path, `toy copy ${String(counter)}`);
  fs.cpSync(TOY, dest, { recursive: true });
  if (only !== undefined) {
    for (const name of ['basic.toy', 'emoji.toy', 'crlf.toy', 'bom.toy']) {
      if (!only.includes(name)) {
        fs.rmSync(path.join(dest, 'fixtures', name), { force: true });
        fs.rmSync(path.join(dest, 'fixtures', `${name}.golden.json`), { force: true });
      }
    }
  }
  return dest;
}

function keysDeep(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      keysDeep(item, into);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      keysDeep(item, into);
    }
  }
  return into;
}

interface GoldenFile {
  readonly hadBom: boolean;
  readonly captures: ReadonlyArray<{
    readonly query: string;
    readonly name: string;
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
    readonly text: string;
  }>;
}

function readGolden(fixture: string): GoldenFile {
  return JSON.parse(fs.readFileSync(path.join(TOY, 'fixtures', `${fixture}.golden.json`), 'utf8')) as GoldenFile;
}

describe('gsd-atlas lang test, as a real process', () => {
  it('runs the toy module over the basic fixture and exits 0', async () => {
    const out = await atlas(['lang', 'test', copyToy(['basic.toy'])]);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.envelope.schema, 'gsd-atlas.lang-test/1');
    assert.equal(out.envelope.ok, true);
    assert.deepEqual(out.envelope.data, { ok: true, module: 'toy', fixtures: [{ file: 'basic.toy', ok: true }], diagnostics: [] });
    assert.equal(out.stderr, '');
  });

  it('prints no parse-quality number (D-02): that metric belongs to the CI budget job', async () => {
    const out = await atlas(['lang', 'test', copyToy(['basic.toy'])]);
    const keys = keysDeep(out.envelope);
    for (const name of ['errorBytes', 'totalBytes', 'ratio', 'parseBudget', 'missingNodes']) {
      assert.ok(!keys.includes(name), `${name} must not appear in the lang test output`);
    }
  });

  it('checks the basic golden against positions worked out by hand from basic.toy', () => {
    // basic.toy: line 1 `use "lib/util";`, line 2 `fn main {`, line 3 `  helper();`, line 5 `type Widget {`.
    const at = (query: string, name: string, text: string): string => {
      const c = readGolden('basic.toy').captures.find((x) => x.query === query && x.name === name && x.text === text);
      assert.ok(c, `golden has ${query} ${name} ${JSON.stringify(text)}`);
      return `${String(c.startLine)}:${String(c.startColumn)}-${String(c.endLine)}:${String(c.endColumn)}`;
    };
    assert.equal(at('imports', 'import.es', 'use "lib/util";'), '1:0-1:15');
    assert.equal(at('imports', 'import.path', '"lib/util"'), '1:4-1:14');
    assert.equal(at('tags', 'name', 'main'), '2:3-2:7');
    assert.equal(at('refs', 'reference.call', 'helper'), '3:2-3:8');
    assert.equal(at('tags', 'name', 'Widget'), '5:5-5:11');
    assert.equal(readGolden('basic.toy').hadBom, false);
  });

  it('exits 1 for a target that is not a module folder, with module_not_found', async () => {
    const out = await atlas(['lang', 'test', path.join(temp.path, 'nosuch')]);
    assert.equal(out.exitCode, 1);
    assert.equal(out.envelope.ok, false);
    assert.deepEqual(
      out.envelope.diagnostics.map((d) => d.code),
      ['module_not_found'],
    );
    assert.match(out.stderr, /^gsd-atlas: error module_not_found: /);
    assert.ok(!out.stderr.includes('    at '), 'no stack trace');
  });
});

/** [query, name, startLine, startColumn, endLine, endColumn, text], typed by hand from the fixture bytes (not from the engine). */
type Row = readonly [string, string, number, number, number, number, string];

function rowsOf(fixture: string): Row[] {
  return readGolden(fixture).captures.map((c): Row => [c.query, c.name, c.startLine, c.startColumn, c.endLine, c.endColumn, c.text]);
}

const BASIC_ROWS: readonly Row[] = [
  ['imports', 'import.es', 1, 0, 1, 15, 'use "lib/util";'],
  ['imports', 'import.path', 1, 4, 1, 14, '"lib/util"'],
  ['tags', 'definition.function', 2, 0, 4, 1, 'fn main {\n  helper();\n}'],
  ['tags', 'name', 2, 3, 2, 7, 'main'],
  ['refs', 'reference.call', 3, 2, 3, 8, 'helper'],
  ['tags', 'definition.type', 5, 0, 6, 1, 'type Widget {\n}'],
  ['tags', 'name', 5, 5, 5, 11, 'Widget'],
];

describe('toy goldens: hand-verified UTF-16, CRLF and BOM numbers (D-02)', () => {
  it('emoji.toy: the emoji counts as two UTF-16 units, so later columns move by two, not four', () => {
    // line 1 is `use "a<U+1F600>b";`: `use ` is 4 units, the string is quote, a, 2 emoji units, b, quote = 6 units.
    // line 2 is `fn h<e-acute>llo {`: the name starts after `fn ` (3) and has 5 units.
    // line 3 is `  call();`: the call target starts after two spaces and has 4 units.
    const rows = rowsOf('emoji.toy');
    // The whole statement `use "a<emoji>b";` is 4 + 6 + 1 = 11 units (13 UTF-8 bytes).
    assert.deepEqual(rows, [
      ['imports', 'import.es', 1, 0, 1, 11, 'use "a\u{1F600}b";'],
      ['imports', 'import.path', 1, 4, 1, 10, '"a\u{1F600}b"'],
      ['tags', 'definition.function', 2, 0, 4, 1, 'fn héllo {\n  call();\n}'],
      ['tags', 'name', 2, 3, 2, 8, 'héllo'],
      ['refs', 'reference.call', 3, 2, 3, 6, 'call'],
    ]);
    assert.equal(rows[1]![6].length, 6, 'the string token is six UTF-16 code units');
    assert.equal(readGolden('emoji.toy').hadBom, false);
  });

  it('crlf.toy: same positions as basic.toy; text differs only by the \\r the file really contains', () => {
    const rows = rowsOf('crlf.toy');
    assert.equal(rows.length, BASIC_ROWS.length);
    rows.forEach((row, i) => {
      const want = BASIC_ROWS[i]!;
      assert.deepEqual(row.slice(0, 6), want.slice(0, 6), `capture ${String(i)} span`);
      assert.equal(row[6], want[6].replaceAll('\n', '\r\n'), `capture ${String(i)} text`);
    });
    assert.equal(readGolden('crlf.toy').hadBom, false);
  });

  it('bom.toy: hadBom is true and the name a sits at line 0 columns 3 to 4 once the BOM is stripped', () => {
    const golden = readGolden('bom.toy');
    assert.equal(golden.hadBom, true);
    assert.deepEqual(rowsOf('bom.toy'), [
      ['tags', 'definition.function', 0, 0, 1, 1, 'fn a {\n}'],
      ['tags', 'name', 0, 3, 0, 4, 'a'],
    ]);
  });

  it('basic.toy keeps its typed numbers', () => {
    assert.deepEqual(rowsOf('basic.toy'), BASIC_ROWS);
  });

  it('writes the goldens as LF-only JSON with the convention text', () => {
    for (const name of ['basic', 'emoji', 'crlf', 'bom']) {
      const bytes = fs.readFileSync(path.join(TOY, 'fixtures', `${name}.toy.golden.json`));
      assert.ok(!bytes.includes(0x0d), `${name}.toy.golden.json has no CR byte`);
      assert.equal(bytes[0], 0x7b, `${name}.toy.golden.json has no BOM`);
      assert.ok(bytes.toString('utf8').includes('"convention": "0-based line, 0-based UTF-16 column, end exclusive"'));
    }
  });
});

describe('gsd-atlas lang test: exit codes and diagnostics', () => {
  it('runs the unmodified toy module over all four fixtures and exits 0', async () => {
    const out = await atlas(['lang', 'test', TOY]);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(out.envelope.data, {
      ok: true,
      module: 'toy',
      fixtures: [
        { file: 'basic.toy', ok: true },
        { file: 'bom.toy', ok: true },
        { file: 'crlf.toy', ok: true },
        { file: 'emoji.toy', ok: true },
      ],
      diagnostics: [],
    });
  });

  it('works when the module folder is an absolute path containing spaces', async () => {
    const dir = copyToy();
    assert.ok(dir.includes(' '));
    assert.ok(path.isAbsolute(dir));
    const out = await atlas(['lang', 'test', dir]);
    assert.equal(out.exitCode, 0, out.stderr);
  });

  it('exits 2 with golden_mismatch naming the fixture, the capture and both values', async () => {
    const dir = copyToy();
    const goldenPath = path.join(dir, 'fixtures', 'emoji.toy.golden.json');
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as { captures: Array<Record<string, unknown>> };
    assert.equal(golden.captures[0]!['endColumn'], 11);
    golden.captures[0]!['endColumn'] = 10;
    fs.writeFileSync(goldenPath, `${JSON.stringify(golden, null, 2)}\n`);

    const out = await atlas(['lang', 'test', dir]);
    assert.equal(out.exitCode, 2);
    assert.equal(out.envelope.ok, false);
    const [problem, ...rest] = out.envelope.diagnostics;
    assert.deepEqual(rest, []);
    assert.equal(problem?.code, 'golden_mismatch');
    assert.ok(problem.message.includes('emoji.toy'));
    assert.ok(problem.message.includes('capture 0 field endColumn'));
    assert.ok(problem.message.includes('expected 10, actual 11'));
    assert.match(out.stderr, /^gsd-atlas: error golden_mismatch: emoji\.toy: /);
  });

  it('exits 2 with golden_missing when a golden file is absent', async () => {
    const dir = copyToy();
    fs.rmSync(path.join(dir, 'fixtures', 'bom.toy.golden.json'));
    const out = await atlas(['lang', 'test', dir]);
    assert.equal(out.exitCode, 2);
    assert.deepEqual(
      out.envelope.diagnostics.map((d) => d.code),
      ['golden_missing'],
    );
    assert.ok(out.envelope.diagnostics[0]!.message.includes('bom.toy'));
  });

  it('exits 2 with wasm_hash_mismatch when grammar.wasm was tampered with, without an ABI crash', async () => {
    const dir = copyToy();
    const wasmPath = path.join(dir, 'grammar.wasm');
    const bytes = fs.readFileSync(wasmPath);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    fs.writeFileSync(wasmPath, bytes);
    const out = await atlas(['lang', 'test', dir]);
    assert.equal(out.exitCode, 2);
    assert.deepEqual(
      out.envelope.diagnostics.map((d) => d.code),
      ['wasm_hash_mismatch'],
    );
    assert.ok(!out.stderr.includes('    at '), 'no stack trace');
  });

  it('exits 2 with manifest_invalid and no stack trace for an invalid manifest', async () => {
    const dir = copyToy();
    fs.writeFileSync(path.join(dir, 'atlas-lang.json'), '{}');
    const out = await atlas(['lang', 'test', dir]);
    assert.equal(out.exitCode, 2);
    assert.equal(out.envelope.ok, false);
    assert.ok(out.envelope.diagnostics.length > 0);
    assert.ok(out.envelope.diagnostics.every((d) => d.code === 'manifest_invalid'));
    assert.match(out.stderr, /^gsd-atlas: warning manifest_invalid: /);
    assert.ok(!out.stderr.includes('    at '), 'no stack trace');
  });

  it('exits 2 with manifest_unreadable for a folder without a manifest', async () => {
    const dir = path.join(temp.path, 'bare folder');
    fs.mkdirSync(dir);
    const out = await atlas(['lang', 'test', dir]);
    assert.equal(out.exitCode, 2);
    assert.deepEqual(
      out.envelope.diagnostics.map((d) => d.code),
      ['manifest_unreadable'],
    );
  });

  it('exits 1 for a missing target, an unknown command and an unsupported flag', async () => {
    for (const args of [['lang', 'test'], ['lang', 'test', 'a', 'b'], ['lang', 'frobnicate'], ['lang', 'test', TOY, '--json'], []]) {
      const out = await spawnAtlas(args);
      assert.equal(out.exitCode, 1, `args ${JSON.stringify(args)}`);
      assert.equal(out.stdout, '', 'a usage error prints no envelope');
      assert.match(out.stderr, /^gsd-atlas: /);
      assert.ok(!out.stderr.includes('    at '), 'no stack trace');
    }
  });

  it('prints the version and usage with exit 0', async () => {
    const version = await spawnAtlas(['--version']);
    assert.equal(version.exitCode, 0);
    assert.match(version.stdout, /^gsd-atlas \d+\.\d+\.\d+/);
    const help = await spawnAtlas(['--help']);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /lang test <module-folder>/);
    assert.match(help.stdout, /lang list/);
  });
});

interface ListedModule {
  readonly name: string;
  readonly source: string;
  readonly dir: string;
  readonly extensions: string[];
  readonly inactiveExtensions: string[];
  readonly tiers: Array<{ tier: string; active: boolean; reason?: string }>;
  readonly shadowed: Array<{ source: string; dir: string }>;
}

interface RootLayout {
  readonly repo: string;
  readonly user: string;
  readonly npm: string;
  readonly builtin: string;
  /** The four root flags pointing at this layout. */
  readonly flags: string[];
  folder(source: 'repo' | 'user' | 'npm' | 'builtin', name: string): string;
}

let layoutCounter = 0;
/** Four empty search locations under the shared temp dir, wired up as root flags. */
function layout(): RootLayout {
  layoutCounter += 1;
  const base = path.join(temp.path, `layout ${String(layoutCounter)}`);
  const repo = path.join(base, 'repo');
  const user = path.join(base, 'user');
  const npm = path.join(base, 'npm');
  const builtin = path.join(base, 'builtin');
  return {
    repo,
    user,
    npm,
    builtin,
    flags: ['--repo-root', repo, '--user-dir', user, '--npm-root', npm, '--builtin-dir', builtin],
    folder(source, name) {
      switch (source) {
        case 'repo':
          return path.join(repo, '.gsd-atlas', 'languages', name);
        case 'user':
          return path.join(user, 'languages', name);
        case 'npm':
          return path.join(npm, 'node_modules', `gsd-atlas-lang-${name}`);
        case 'builtin':
          return path.join(builtin, name);
      }
    },
  };
}

const modulesOf = (out: Outcome): ListedModule[] => (out.envelope.data as { modules: ListedModule[] }).modules;

describe('gsd-atlas lang list and lang test <id>, as real processes (D-03, LNG-01)', () => {
  it('lists the toy module with its source, active tier, extensions and shadowed copies, and exits 0', async () => {
    const l = layout();
    fs.cpSync(TOY, l.folder('repo', 'toy'), { recursive: true });
    fs.cpSync(TOY, l.folder('npm', 'toy'), { recursive: true });
    fs.cpSync(TOY, l.folder('builtin', 'toy'), { recursive: true });

    const out = await atlas(['lang', 'list', ...l.flags]);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.envelope.schema, 'gsd-atlas.lang-list/1');
    assert.equal(out.envelope.ok, true);
    assert.deepEqual(out.envelope.diagnostics, []);
    const [toy, ...rest] = modulesOf(out);
    assert.deepEqual(rest, []);
    assert.equal(toy?.name, 'toy');
    assert.equal(toy.source, 'repo');
    assert.deepEqual(toy.extensions, ['.toy']);
    assert.deepEqual(toy.inactiveExtensions, []);
    assert.deepEqual(toy.tiers, [{ tier: 'grammar', active: true }]);
    assert.deepEqual(toy.shadowed.map((s) => s.source), ['npm', 'builtin']);
    assert.equal(fs.realpathSync.native(toy.dir), fs.realpathSync.native(l.folder('repo', 'toy')));
  });

  it('lists nothing, with an ok envelope and exit 0, when no location exists', async () => {
    const out = await atlas(['lang', 'list', ...layout().flags]);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.envelope.ok, true);
    assert.deepEqual(out.envelope.data, { modules: [] });
    assert.equal(out.stderr, '');
  });

  it('accepts relative root flags and several --npm-root flags', async () => {
    const l = layout();
    fs.cpSync(TOY, path.join(l.npm, 'node_modules', '@opengsd', 'atlas-lang-toy'), { recursive: true });
    const second = path.join(temp.path, `second npm ${String(layoutCounter)}`);
    const out = await atlas([
      'lang', 'list',
      '--repo-root', path.relative(process.cwd(), l.repo),
      '--user-dir', l.user,
      '--builtin-dir', l.builtin,
      '--npm-root', l.npm,
      '--npm-root', second,
    ]);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(modulesOf(out).map((m) => [m.name, m.source]), [['toy', 'npm']]);
  });

  it('lang test toy resolves the id through the registry, tests all four fixtures and exits 0', async () => {
    const l = layout();
    fs.cpSync(TOY, l.folder('repo', 'toy'), { recursive: true });
    const out = await atlas(['lang', 'test', 'toy', ...l.flags]);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.envelope.schema, 'gsd-atlas.lang-test/1');
    assert.deepEqual(out.envelope.data, {
      ok: true,
      module: 'toy',
      fixtures: [
        { file: 'basic.toy', ok: true },
        { file: 'bom.toy', ok: true },
        { file: 'crlf.toy', ok: true },
        { file: 'emoji.toy', ok: true },
      ],
      diagnostics: [],
    });
  });

  it('lang test nosuch exits 1 with module_not_found', async () => {
    const l = layout();
    fs.cpSync(TOY, l.folder('repo', 'toy'), { recursive: true });
    const out = await atlas(['lang', 'test', 'nosuch', ...l.flags]);
    assert.equal(out.exitCode, 1);
    assert.equal(out.envelope.ok, false);
    assert.deepEqual(out.envelope.diagnostics.map((d) => d.code), ['module_not_found']);
  });

  it('lang test <folder> still works with root flags present', async () => {
    const out = await atlas(['lang', 'test', TOY, ...layout().flags]);
    assert.equal(out.exitCode, 0, out.stderr);
  });

  it('skips an invalid repo copy with a manifest_invalid warning, uses the valid user copy, and exits 0', async () => {
    const l = layout();
    const bad = l.folder('repo', 'toy');
    fs.cpSync(TOY, bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'atlas-lang.json'), '{}');
    fs.cpSync(TOY, l.folder('user', 'toy'), { recursive: true });

    const listed = await atlas(['lang', 'list', ...l.flags]);
    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.equal(modulesOf(listed)[0]?.source, 'user');
    assert.ok(listed.envelope.diagnostics.length > 0);
    assert.ok(listed.envelope.diagnostics.every((x) => x.code === 'manifest_invalid'));
    assert.match(listed.stderr, /^gsd-atlas: warning manifest_invalid: /);
    assert.ok(!listed.stderr.includes('    at '), 'no stack trace');

    const tested = await atlas(['lang', 'test', 'toy', ...l.flags]);
    assert.equal(tested.exitCode, 0, tested.stderr);
    assert.equal(tested.envelope.ok, true);
  });

  it('skips a name_mismatch folder with a warning, never a crash, and lists the valid copy below it', async () => {
    const l = layout();
    const wrong = l.folder('repo', 'toy');
    fs.cpSync(TOY, wrong, { recursive: true });
    const manifestPath = path.join(wrong, 'atlas-lang.json');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8').replace('"name": "toy"', '"name": "other"'));
    fs.cpSync(TOY, l.folder('builtin', 'toy'), { recursive: true });

    const out = await atlas(['lang', 'list', ...l.flags]);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(out.envelope.diagnostics.map((x) => x.code), ['name_mismatch']);
    assert.deepEqual(modulesOf(out).map((m) => [m.name, m.source]), [['toy', 'builtin']]);
    assert.match(out.stderr, /^gsd-atlas: warning name_mismatch: /);
  });

  it('reports extension_collision as an error diagnostic and lists the contested extension as inactive', async () => {
    const l = layout();
    fs.cpSync(TOY, l.folder('repo', 'toy'), { recursive: true });
    const second = l.folder('user', 'toy2');
    fs.cpSync(TOY, second, { recursive: true });
    const manifestPath = path.join(second, 'atlas-lang.json');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8').replace('"name": "toy"', '"name": "toy2"'));

    const out = await atlas(['lang', 'list', ...l.flags]);
    assert.equal(out.exitCode, 0, out.stderr);
    const collision = out.envelope.diagnostics.find((x) => x.code === 'extension_collision');
    assert.equal(collision?.severity, 'error');
    assert.match(out.stderr, /^gsd-atlas: error extension_collision: /);
    const toy2 = modulesOf(out).find((m) => m.name === 'toy2');
    assert.deepEqual(toy2?.inactiveExtensions, ['.toy']);
  });

  it('never runs a precise command from a manifest: list and test pass and the marker file is never written', async () => {
    const l = layout();
    const marker = path.join(temp.path, `precise marker ${String(layoutCounter)}.txt`);
    const dir = l.folder('repo', 'toy');
    fs.cpSync(TOY, dir, { recursive: true });
    const manifestPath = path.join(dir, 'atlas-lang.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['tiers'] = ['grammar', 'precise', 'platform'];
    manifest['precise'] = { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const listed = await atlas(['lang', 'list', ...l.flags]);
    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.deepEqual(modulesOf(listed)[0]?.tiers, [
      { tier: 'grammar', active: true },
      { tier: 'precise', active: false, reason: 'command_not_approved' },
      { tier: 'platform', active: false, reason: 'no_sdk_provider' },
    ]);
    assert.deepEqual(listed.envelope.diagnostics.map((x) => x.code), ['precise_command_inactive']);

    const tested = await atlas(['lang', 'test', 'toy', ...l.flags]);
    assert.equal(tested.exitCode, 0, tested.stderr);
    assert.equal(tested.envelope.ok, true);

    assert.equal(fs.existsSync(marker), false, 'the precise command in the manifest must never have started');
  });
});
