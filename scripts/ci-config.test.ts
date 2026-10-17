import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Static, line-oriented assertions over every workflow file. No YAML library is installed and none is added:
// the workflows are written in a plain block style that these checks rely on.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(root, '.github', 'workflows');

const files = fs.readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f)).sort();

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === '' || line.trim().startsWith('#');

function readLines(file: string): string[] {
  // Normalise CRLF so a Windows checkout cannot change what the checks see.
  return fs.readFileSync(path.join(workflowDir, file), 'utf8').split(/\r?\n/);
}

/** Lines strictly nested under the key on line `start` (indent greater than the key's), blank lines skipped. */
function blockUnder(lines: string[], start: number): string[] {
  const base = indentOf(lines[start] ?? '');
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isBlank(line)) continue;
    if (indentOf(line) <= base) break;
    out.push(line);
  }
  return out;
}

function topLevelKey(lines: string[], key: string): number {
  return lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
}

/** Job name to the lines nested under it, from the top-level `jobs:` mapping. */
function jobs(lines: string[]): Map<string, string[]> {
  const start = topLevelKey(lines, 'jobs');
  assert.ok(start >= 0, 'workflow has no jobs: key');
  const result = new Map<string, string[]>();
  const body = blockUnder(lines, start);
  let current: string | undefined;
  for (const line of body) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) {
      current = m[1] as string;
      result.set(current, []);
    } else if (current !== undefined) {
      result.get(current)?.push(line);
    }
  }
  return result;
}

/** The lines of the step (list item) that contains line `i`. */
function stepAround(lines: string[], i: number): string[] {
  const keyIndent = indentOf((lines[i] ?? '').replace(/^(\s*)-\s+/, '$1  '));
  let start = i;
  while (start > 0) {
    const m = /^(\s*)-\s/.exec(lines[start] ?? '');
    if (m && (m[1] as string).length < keyIndent) break;
    start--;
  }
  let end = i + 1;
  while (end < lines.length) {
    const line = lines[end] ?? '';
    const m = /^(\s*)-\s/.exec(line);
    if (!isBlank(line) && ((m && (m[1] as string).length < keyIndent) || indentOf(line) < keyIndent)) break;
    end++;
  }
  return lines.slice(start, end);
}

const codeLines = (lines: string[]): { text: string; i: number }[] =>
  lines.map((text, i) => ({ text, i })).filter(({ text }) => !text.trim().startsWith('#'));

test('workflows: the glob finds ci.yml and skips nothing', () => {
  assert.ok(files.length >= 1, 'no workflow files found under .github/workflows');
  assert.ok(files.includes('ci.yml'), 'ci.yml is missing');
});

for (const file of files) {
  const lines = readLines(file);
  const text = lines.join('\n');

  test(`${file}: every uses: is pinned to a 40-hex commit SHA with a version comment`, () => {
    const uses = codeLines(lines).filter(({ text: t }) => /^\s*(?:-\s+)?uses:/.test(t));
    assert.ok(uses.length > 0, 'workflow uses no actions (unexpected)');
    for (const { text: t, i } of uses) {
      assert.match(
        t,
        /^\s*(?:-\s+)?uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/,
        `line ${i + 1} is not owner/repo@<40 hex> # vX.Y.Z: ${t.trim()}`,
      );
    }
  });

  test(`${file}: top-level permissions grant only contents: read`, () => {
    const at = topLevelKey(lines, 'permissions');
    assert.ok(at >= 0, 'no top-level permissions: block');
    assert.deepEqual(blockUnder(lines, at).map((l) => l.trim()), ['contents: read']);
    assert.doesNotMatch(text, /write-all|read-all/);
  });

  test(`${file}: pull_request_target appears nowhere`, () => {
    assert.ok(!text.includes('pull_request_target'));
  });

  test(`${file}: every checkout step sets persist-credentials: false`, () => {
    const checkouts = codeLines(lines).filter(({ text: t }) => /uses:\s+actions\/checkout@/.test(t));
    for (const { i } of checkouts) {
      const step = stepAround(lines, i).join('\n');
      assert.match(step, /^\s*persist-credentials:\s*false\s*$/m, `checkout at line ${i + 1} persists credentials`);
    }
  });

  test(`${file}: every npm ci uses --ignore-scripts and no npm install exists`, () => {
    for (const { text: t, i } of codeLines(lines)) {
      if (/\bnpm\s+ci\b/.test(t)) assert.match(t, /--ignore-scripts/, `line ${i + 1}: npm ci without --ignore-scripts`);
      assert.doesNotMatch(t, /\bnpm\s+(?:install|i|add)\b/, `line ${i + 1}: npm install is not allowed, use npm ci`);
    }
  });

  test(`${file}: every matrix sets fail-fast: false`, () => {
    const strategies = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\s*strategy:\s*$/.test(l));
    const matrices = codeLines(lines).filter(({ text: t }) => /^\s*matrix:\s*$/.test(t));
    assert.equal(strategies.length, matrices.length, 'each strategy block must hold one matrix');
    for (const { i } of strategies) {
      assert.ok(blockUnder(lines, i).some((l) => /^\s*fail-fast:\s*false\s*$/.test(l)), `strategy at line ${i + 1} lacks fail-fast: false`);
    }
  });

  test(`${file}: concurrency cancels superseded runs`, () => {
    const at = topLevelKey(lines, 'concurrency');
    assert.ok(at >= 0, 'no top-level concurrency: block');
    assert.ok(blockUnder(lines, at).some((l) => /^\s*cancel-in-progress:\s*true\s*$/.test(l)));
  });

  test(`${file}: defaults.run.shell is bash`, () => {
    const at = topLevelKey(lines, 'defaults');
    assert.ok(at >= 0, 'no top-level defaults: block');
    const block = blockUnder(lines, at).map((l) => l.trim());
    assert.ok(block.includes('run:'), 'defaults has no run:');
    assert.ok(block.includes('shell: bash'), 'defaults.run.shell is not bash');
  });

  test(`${file}: every job sets timeout-minutes`, () => {
    for (const [name, body] of jobs(lines)) {
      assert.ok(body.some((l) => /^ {4}timeout-minutes:\s*\d+\s*$/.test(l)), `job ${name} has no timeout-minutes`);
    }
  });
}

test('ci.yml: jobs are static, test, grammar and gates', () => {
  assert.deepEqual([...jobs(readLines('ci.yml')).keys()].sort(), ['gates', 'grammar', 'static', 'test']);
});

test('ci.yml: triggers are pull_request, push on main and ci/**, and workflow_dispatch', () => {
  const text = readLines('ci.yml').join('\n');
  assert.match(text, /^on:\s*$/m);
  assert.match(text, /^ {2}pull_request:/m);
  assert.match(text, /^ {2}workflow_dispatch:/m);
  assert.match(text, /branches:\s*\[\s*main\s*,\s*"ci\/\*\*"\s*\]/);
});

test('ci.yml: runner labels and Node versions cover three OSes and Node 24.16.0 and 26', () => {
  const lines = readLines('ci.yml');
  const text = lines.join('\n');
  for (const label of ['ubuntu-latest', 'macos-latest', 'windows-latest']) assert.ok(text.includes(label), label + ' missing');
  const j = jobs(lines);
  assert.match((j.get('static') ?? []).join('\n'), /runs-on:\s*ubuntu-latest/);
  assert.match((j.get('static') ?? []).join('\n'), /node-version:\s*"24\.16\.0"/);
  const matrixOs = /os:\s*\[\s*ubuntu-latest\s*,\s*macos-latest\s*,\s*windows-latest\s*\]/;
  assert.match((j.get('test') ?? []).join('\n'), matrixOs);
  assert.match((j.get('test') ?? []).join('\n'), /node:\s*\[\s*"24\.16\.0"\s*,\s*"26"\s*\]/);
  assert.match((j.get('grammar') ?? []).join('\n'), matrixOs);
  assert.match((j.get('grammar') ?? []).join('\n'), /node-version:\s*"24\.16\.0"/);
});

test('ci.yml: static job runs lint, typecheck and schema:check once; test job runs build, test, grammar:budget', () => {
  const j = jobs(readLines('ci.yml'));
  const staticJob = (j.get('static') ?? []).join('\n');
  for (const cmd of ['npm run lint', 'npm run typecheck', 'npm run schema:check']) assert.ok(staticJob.includes(cmd), cmd + ' missing from static');
  const testJob = (j.get('test') ?? []).join('\n');
  for (const cmd of ['npm run build', 'npm test', 'npm run grammar:budget', 'node --version', 'npm --version']) assert.ok(testJob.includes(cmd), cmd + ' missing from test');
  for (const cmd of ['npm run lint', 'npm run typecheck', 'npm run schema:check']) assert.ok(!testJob.includes(cmd), cmd + ' must run only in static');
});

test('ci.yml: only the grammar job caches the tree-sitter toolchain and fetches wasi-sdk (D-07)', () => {
  const j = jobs(readLines('ci.yml'));
  const grammar = (j.get('grammar') ?? []).join('\n');
  assert.match(grammar, /uses:\s+actions\/cache@/);
  assert.ok(grammar.includes('${{ runner.os }}-wasi34-binaryen132'));
  assert.ok(grammar.includes('~/.cache/tree-sitter'));
  assert.ok(grammar.includes('~\\AppData\\Local\\tree-sitter'));
  assert.ok(grammar.includes('node scripts/ensure-tree-sitter.ts'));
  assert.ok(grammar.includes('npm run grammar:verify'));
  for (const name of ['static', 'test']) {
    const body = (j.get(name) ?? []).join('\n');
    assert.ok(!body.includes('actions/cache@'), `${name} must not use actions/cache`);
    assert.ok(!body.includes('wasi') && !body.includes('ensure-tree-sitter'), `${name} must not touch the wasi toolchain`);
  }
});

test('ci.yml: uses no secrets', () => {
  assert.doesNotMatch(readLines('ci.yml').join('\n'), /secrets\./);
});

// The measured gates of plan 02-26. The bounds are the approved constants of 02-CONSTANTS.md: a pull request gets the
// looser hosted-runner ceiling (gate.freshnessPrCeilingMs), the nightly run and local runs get the ROADMAP's one second
// (gate.freshnessNightlyP99Ms). A larger number in either workflow is a loosened gate and fails here.
const FRESHNESS_PR_CEILING_MS = 3000;
const FRESHNESS_NIGHTLY_P99_MS = 1000;

const maxMsOf = (text: string): number[] => [...text.matchAll(/scripts\/freshness-gate\.ts[^\n]*--max-ms\s+(\d+)/g)].map((match) => Number(match[1]));

test('ci.yml: the gates job runs on three operating systems at the Node floor and runs the four gates in order', () => {
  const lines = readLines('ci.yml');
  const gates = (jobs(lines).get('gates') ?? []).join('\n');
  assert.match(gates, /os:\s*\[\s*ubuntu-latest\s*,\s*macos-latest\s*,\s*windows-latest\s*\]/);
  assert.match(gates, /node-version:\s*"24\.16\.0"/);
  assert.match(gates, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  const order = ['npm ci --ignore-scripts', 'npm run build', 'scripts/recall.ts --corpus gsd-core', 'scripts/corpus-gates.ts', 'scripts/size-gate.ts', 'scripts/freshness-gate.ts'];
  let from = 0;
  for (const needle of order) {
    const at = gates.indexOf(needle, from);
    assert.ok(at >= from, `${needle} is missing from the gates job or out of order`);
    from = at + needle.length;
  }
  assert.ok(!/--edits\b/.test(gates), 'the size gate must run at its full 20,000 edits, not a reduced count');
  assert.deepEqual(maxMsOf(gates), [FRESHNESS_PR_CEILING_MS]);
});

test('ci.yml: the gates job does not install, cache a toolchain or use secrets', () => {
  const gates = (jobs(readLines('ci.yml')).get('gates') ?? []).join('\n');
  assert.doesNotMatch(gates, /\bnpm\s+(?:install|i|add)\b/);
  assert.ok(!gates.includes('actions/cache@') && !gates.includes('wasi') && !gates.includes('ensure-tree-sitter'));
});

test('nightly.yml: triggers on one schedule entry and workflow_dispatch, and runs the strict freshness gate and the corpus gates', () => {
  assert.ok(files.includes('nightly.yml'), 'nightly.yml is missing');
  const lines = readLines('nightly.yml');
  const text = lines.join('\n');
  assert.match(text, /^on:\s*$/m);
  assert.match(text, /^ {2}schedule:\s*$/m);
  assert.match(text, /^ {2}workflow_dispatch:/m);
  assert.equal([...text.matchAll(/^\s*-\s+cron:\s*"[^"]+"\s*$/gm)].length, 1, 'exactly one cron entry');
  assert.doesNotMatch(text, /^ {2}(?:pull_request|push):/m, 'nightly runs on a schedule and by hand only');
  assert.match(text, /os:\s*\[\s*ubuntu-latest\s*,\s*macos-latest\s*,\s*windows-latest\s*\]/);
  assert.match(text, /node-version:\s*"24\.16\.0"/);
  assert.ok(text.includes('scripts/corpus-gates.ts'));
  assert.deepEqual(maxMsOf(text), [FRESHNESS_NIGHTLY_P99_MS]);
});

test('ci.yml: the grammar job prints each module rebuild hash before it judges them, so a new platform entry comes from evidence', () => {
  const grammar = (jobs(readLines('ci.yml')).get('grammar') ?? []).join('\n');
  const report = grammar.indexOf('node scripts/grammar-build.ts --report');
  const verify = grammar.indexOf('npm run grammar:verify');
  assert.ok(report >= 0, 'the grammar job does not print the rebuild hashes');
  assert.ok(report < verify, 'the hashes are printed before grammar:verify runs');
});
