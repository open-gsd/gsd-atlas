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

async function atlas(args: readonly string[]): Promise<Outcome> {
  const result = await runner.run({ executable: process.execPath, args: [BIN, ...args] });
  const stdout = Buffer.from(result.stdout).toString('utf8');
  const stderr = Buffer.from(result.stderr).toString('utf8');
  assert.equal(result.spawnError, undefined, 'the bin must start');
  const lines = stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, `stdout carries exactly one JSON envelope, got: ${stdout}`);
  assert.ok(stdout.endsWith('\n'));
  return { exitCode: result.exitCode, stdout, stderr, envelope: JSON.parse(lines[0]!) as Outcome['envelope'] };
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
