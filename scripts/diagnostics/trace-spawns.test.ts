/**
 * The opt-in spawn trace preload (plan 02-46). Each case runs a tiny script in a child Node process with
 * `--import trace-spawns.mjs`, so the preload is exercised exactly as the CI step uses it, and then reads the trace.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

const preload = pathToFileURL(path.join(import.meta.dirname, 'trace-spawns.mjs')).href;
const productRoot = path.resolve(import.meta.dirname, '..', '..');

function makeScratch(t: TestContext): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-atlas-trace-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** Runs `source` as an ES module in a child Node with the preload, returning its result and the trace text. */
function runTraced(
  t: TestContext,
  source: string,
  options: { readonly traceFile?: (scratch: string) => string | undefined; readonly args?: (scratch: string) => string[] } = {},
): { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly trace: string; readonly scratch: string; readonly traceFile: string | undefined } {
  const scratch = makeScratch(t);
  const script = path.join(scratch, 'child.mjs');
  fs.writeFileSync(script, source);
  const work = path.join(scratch, 'work');
  fs.mkdirSync(work);
  const traceFile = options.traceFile === undefined ? path.join(scratch, 'trace.log') : options.traceFile(scratch);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['GSD_ATLAS_TRACE_FILE'];
  if (traceFile !== undefined) env['GSD_ATLAS_TRACE_FILE'] = traceFile;
  const result = spawnSync(process.execPath, ['--import', preload, script, work, ...(options.args?.(scratch) ?? [])], { env, encoding: 'utf8' });
  let trace = '';
  try {
    if (traceFile !== undefined && fs.statSync(traceFile).isFile()) trace = fs.readFileSync(traceFile, 'utf8');
  } catch {
    trace = '';
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, trace, scratch, traceFile };
}

const LINE = /^\d+\.\d{2} T\d+ [A-Z]+(?: .+)?$/;
const linesOf = (trace: string): string[] => trace.split('\n').filter((l) => l !== '');
const kindOf = (line: string, kind: string): boolean => new RegExp(`^\\d+\\.\\d{2} T\\d+ ${kind}( |$)`).test(line);

const SPAWN_AND_WRITE_SCRIPT = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const run = (args) => new Promise((resolve) => { const c = spawn('git', args, { stdio: 'ignore' }); c.on('close', resolve); });
await run(['-C', dir, 'init', '--quiet']);
await run(['-C', dir, '-c', 'core.fsmonitor=false', 'rev-parse', '--git-dir']);
fs.mkdirSync(path.join(dir, 'src', 'gen'), { recursive: true });
fs.writeFileSync(path.join(dir, 'src', 'gen', 'secret-name.ts'), 'SECRET_CONTENT');
fs.writeFileSync(path.join(dir, 'src', 'gen', 'secret-name.ts'), 'SECRET_CONTENT, edited');
fs.writeFileSync(path.join(dir, 'elsewhere.txt'), 'not under src/gen');
`;

describe('trace-spawns preload', () => {
  it('records only command and subcommand', (t) => {
    const { status, trace, scratch } = runTraced(t, SPAWN_AND_WRITE_SCRIPT);
    assert.equal(status, 0);
    const lines = linesOf(trace);
    for (const line of lines) assert.match(line, LINE, line);

    const spawns = lines.filter((l) => kindOf(l, 'SPAWN'));
    assert.deepEqual(spawns.map((l) => l.replace(/^\S+ T\d+ /, '')), ['SPAWN #1 git init', 'SPAWN #2 git rev-parse']);
    assert.equal(lines.filter((l) => kindOf(l, 'SPAWNED')).length, 2);
    const closes = lines.filter((l) => kindOf(l, 'CLOSE'));
    assert.equal(closes.length, 2);
    for (const close of closes) {
      const m = /CLOSE #\d+ exit=0 total=(\d+\.\d)ms git (init|rev-parse)$/.exec(close);
      assert.ok(m !== null, close);
      assert.ok(Number(m[1]) >= 0);
    }

    // Nothing but the executable name and the subcommand word: no directory, no other argument, no content.
    for (const secret of [scratch, path.join(scratch, 'work'), os.tmpdir(), 'secret-name', 'SECRET_CONTENT', 'elsewhere', 'core.fsmonitor', '--quiet', '--git-dir', '-C', 'false']) {
      assert.ok(!trace.includes(secret), `the trace must not contain ${secret}`);
    }
  });

  it('write kind without a name', (t) => {
    const { trace } = runTraced(t, SPAWN_AND_WRITE_SCRIPT);
    const writes = linesOf(trace).filter((l) => kindOf(l, 'WRITE'));
    // The first write creates the file, the second edits it, a write outside src/gen is not traced at all.
    assert.equal(writes.length, 2);
    assert.match(writes[0] as string, /^\d+\.\d{2} T\d+ WRITE add$/);
    assert.match(writes[1] as string, /^\d+\.\d{2} T\d+ WRITE edit$/);
  });

  it('sql by verb', (t) => {
    const { status, trace } = runTraced(
      t,
      `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE secret_table (secret_column TEXT)');
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO secret_table VALUES (?)').run('SECRET_VALUE');
db.exec('COMMIT');
db.close();
`,
    );
    assert.equal(status, 0);
    const sql = linesOf(trace).filter((l) => kindOf(l, 'SQL'));
    for (const line of sql) assert.match(line, /^\d+\.\d{2} T\d+ SQL [A-Z?]+ \d+\.\d{2}ms$/, line);
    assert.ok(sql.some((l) => / SQL BEGIN /.test(l)), 'BEGIN is always logged');
    assert.ok(sql.some((l) => / SQL COMMIT /.test(l)), 'COMMIT is always logged');
    for (const text of ['secret_table', 'secret_column', 'SECRET_VALUE', 'IMMEDIATE', 'INTO', 'TEXT']) {
      assert.ok(!trace.includes(text), `the trace must not contain ${text}`);
    }
  });

  it('event without a path', (t) => {
    const require = createRequire(import.meta.url);
    let watcherPath: string;
    try {
      watcherPath = require.resolve('@parcel/watcher', { paths: [productRoot] });
    } catch {
      t.skip('@parcel/watcher is not installed here');
      return;
    }
    const { status, stdout, trace } = runTraced(
      t,
      `
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const watcher = createRequire(import.meta.url)(process.argv[3]);
let seen;
const got = new Promise((resolve) => { seen = resolve; });
const subscription = await watcher.subscribe(dir, () => seen());
fs.writeFileSync(path.join(dir, 'secret-event-name.txt'), 'x');
await got;
await subscription.unsubscribe();
console.log('event-seen');
`,
      { args: () => [watcherPath] },
    );
    assert.equal(status, 0);
    assert.match(stdout, /event-seen/);
    const events = linesOf(trace).filter((l) => kindOf(l, 'EVENT'));
    assert.ok(events.length >= 1, 'the callback was traced');
    for (const line of events) assert.match(line, /^\d+\.\d{2} T\d+ EVENT [a-z,]+ n=\d+$/, line);
    assert.ok(!trace.includes('secret-event-name'));
  });

  it('unset variable does nothing', (t) => {
    const script = `
import childProcess from 'node:child_process';
import fs from 'node:fs';
console.log(JSON.stringify({ spawn: childProcess.spawn.name, write: fs.writeFileSync.name }));
`;
    for (const traceFile of [undefined, '']) {
      const { status, stdout, scratch } = runTraced(t, script, { traceFile: () => traceFile });
      assert.equal(status, 0);
      assert.deepEqual(JSON.parse(stdout), { spawn: 'spawn', write: 'writeFileSync' }, 'nothing was replaced');
      assert.deepEqual(fs.readdirSync(scratch).sort(), ['child.mjs', 'work'], 'no trace file was created');
    }
  });

  it('unwritable file is harmless', (t) => {
    const script = `
import childProcess from 'node:child_process';
console.log(JSON.stringify({ spawn: childProcess.spawn.name }));
const child = childProcess.spawn('git', ['--version'], { stdio: 'ignore' });
child.on('close', (code) => { console.log('git exit ' + code); });
`;
    for (const where of [(scratch: string) => scratch, (scratch: string) => path.join(scratch, 'missing', 'deeper', 'trace.log')]) {
      const { status, stdout, stderr } = runTraced(t, script, { traceFile: where });
      assert.equal(status, 0, stderr);
      assert.equal(stderr, '', 'the preload never writes to the host program');
      assert.match(stdout, /"spawn":"spawn"/, 'nothing was replaced');
      assert.match(stdout, /git exit 0/);
    }
  });

  it('a process that starts no child still writes a valid empty file', (t) => {
    const { status, trace, traceFile } = runTraced(t, `console.log('no children');\n`);
    assert.equal(status, 0);
    assert.ok(traceFile !== undefined && fs.existsSync(traceFile));
    assert.equal(trace, '');
  });

  it('two traced processes write different files and do not interfere', async (t) => {
    const scratch = makeScratch(t);
    const script = path.join(scratch, 'child.mjs');
    fs.writeFileSync(
      script,
      `
import { spawn } from 'node:child_process';
const count = Number(process.argv[2]);
for (let i = 0; i < count; i += 1) {
  await new Promise((resolve) => { spawn('git', ['--version'], { stdio: 'ignore' }).on('close', resolve); });
}
`,
    );
    const start = (file: string, count: number): Promise<number | null> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', preload, script, String(count)], {
          env: { ...process.env, GSD_ATLAS_TRACE_FILE: file },
          stdio: 'ignore',
        });
        child.on('close', resolve);
      });
    const a = path.join(scratch, 'a.log');
    const b = path.join(scratch, 'b.log');
    const [statusA, statusB] = await Promise.all([start(a, 3), start(b, 5)]);
    assert.equal(statusA, 0);
    assert.equal(statusB, 0);
    assert.equal(linesOf(fs.readFileSync(a, 'utf8')).filter((l) => kindOf(l, 'SPAWN')).length, 3);
    assert.equal(linesOf(fs.readFileSync(b, 'utf8')).filter((l) => kindOf(l, 'SPAWN')).length, 5);
    for (const line of [...linesOf(fs.readFileSync(a, 'utf8')), ...linesOf(fs.readFileSync(b, 'utf8'))]) assert.match(line, LINE);
  });

  it('the product and package.json never reference the preload', () => {
    const needles = ['trace-spawns', 'GSD_ATLAS_TRACE_FILE', 'scripts/diagnostics'];
    const hits: string[] = [];
    const scan = (file: string): void => {
      const text = fs.readFileSync(file, 'utf8');
      for (const needle of needles) if (text.includes(needle)) hits.push(`${path.relative(productRoot, file)}: ${needle}`);
    };
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) scan(full);
      }
    };
    walk(path.join(productRoot, 'src'));
    scan(path.join(productRoot, 'package.json'));
    // The tests of this plan and the normal gate scripts are outside `src`; nothing under `src` may mention the trace.
    assert.deepEqual(hits, []);
  });
});
