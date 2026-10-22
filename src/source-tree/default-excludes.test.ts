/**
 * The built-in index exclusions (quick task 261021-re7, D-01): one constant list, its shape, and the proof that every
 * entry means the same to the installed git and to the fake Source Tree's small rule evaluation. The
 * trust-boundaries ADR and ADR 5 amendments of 2026-10-21 describe the feature; the decisions of
 * `appliesToTracked` come from the committed measurement, which this file reads back.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { REPO_CONFIG_MAX_BYTES } from '../tenant/index.ts';
import { createTempGitRepo } from '../test-kit/index.ts';
import { defaultSamples } from './contract.ts';
import { ATLASIGNORE_FILE, ATLASIGNORE_MAX_BYTES, INDEX_DEFAULT_EXCLUDES, defaultPatterns } from './default-excludes.ts';
import { defaultsExclude, isSupportedPattern } from './fake-rules.ts';

const setupRunner = createRealRunner({ decide: allowAll });
const decoder = new TextDecoder();

const ECOSYSTEMS = ['javascript', 'python', 'jvm-rust', 'apple', 'bundle-output'];

const SRC_ROOT = path.resolve(import.meta.dirname, '..');
const MEASUREMENTS = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '.planning',
  'quick',
  '261021-re7-indexer-ignore-rules-built-in-tooling-an',
  '261021-re7-MEASUREMENTS.md',
);

describe('INDEX_DEFAULT_EXCLUDES: the one list', () => {
  it('has unique patterns, a known ecosystem and a rationale of at least 20 characters on every entry', () => {
    assert.ok(INDEX_DEFAULT_EXCLUDES.length > 0);
    const seen = new Set<string>();
    for (const entry of INDEX_DEFAULT_EXCLUDES) {
      assert.ok(!seen.has(entry.pattern), `duplicate pattern ${entry.pattern}`);
      seen.add(entry.pattern);
      assert.ok(ECOSYSTEMS.includes(entry.ecosystem), `${entry.pattern}: ecosystem ${entry.ecosystem}`);
      assert.ok(entry.rationale.length >= 20, `${entry.pattern}: rationale is too short`);
      assert.equal(typeof entry.appliesToTracked, 'boolean');
      assert.ok(entry.pattern.length > 0 && !entry.pattern.startsWith('-') && !entry.pattern.startsWith('!'), entry.pattern);
    }
  });

  it('defaultPatterns("all") lists every pattern and defaultPatterns("tracked") the appliesToTracked ones, in list order', () => {
    assert.deepEqual([...defaultPatterns('all')], INDEX_DEFAULT_EXCLUDES.map((e) => e.pattern));
    assert.deepEqual(
      [...defaultPatterns('tracked')],
      INDEX_DEFAULT_EXCLUDES.filter((e) => e.appliesToTracked).map((e) => e.pattern),
    );
  });

  it('names the file and the cap once: the cap equals the approved repo-supplied-file cap, the file is .atlasignore', () => {
    assert.equal(ATLASIGNORE_FILE, '.atlasignore');
    assert.equal(ATLASIGNORE_MAX_BYTES, 64 * 1024);
    assert.equal(ATLASIGNORE_MAX_BYTES, REPO_CONFIG_MAX_BYTES);
  });

  it('is written in exactly one non-test file under src/', () => {
    // A distinctive entry; the tests and the contract (which iterates the constant) are not counted.
    const probe = '.parcel-cache/';
    assert.ok(INDEX_DEFAULT_EXCLUDES.some((e) => e.pattern === probe));
    const holders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'contract.ts') {
          if (fs.readFileSync(full, 'utf8').includes(probe)) holders.push(path.relative(SRC_ROOT, full).replaceAll('\\', '/'));
        }
      }
    };
    walk(SRC_ROOT);
    assert.deepEqual(holders, ['source-tree/default-excludes.ts']);
  });

  it('keeps the argv of all defaults far below 8 KB', () => {
    const bytes = defaultPatterns('all').reduce((sum, p) => sum + Buffer.byteLength('--exclude') + Buffer.byteLength(p) + 2, 0);
    assert.ok(bytes < 8192, `argv would be ${String(bytes)} bytes`);
  });

  it('every pattern is a form the fake rule evaluation supports', () => {
    for (const entry of INDEX_DEFAULT_EXCLUDES) assert.equal(isSupportedPattern(entry.pattern), true, entry.pattern);
  });

  it('appliesToTracked follows the committed measurement: TRACKED-OK is true, UNTRACKED-ONLY is false', (t) => {
    if (!fs.existsSync(MEASUREMENTS)) {
      t.skip('the measurement file is not part of this checkout');
      return;
    }
    const text = fs.readFileSync(MEASUREMENTS, 'utf8');
    const start = text.indexOf('\n## Per-entry decision\n');
    const end = text.indexOf('\n## ', start + 1);
    const table = text.slice(start, end);
    const decided = new Map<string, string>();
    for (const line of table.split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      const pattern = /^`(.+)`$/.exec(cells[1] ?? '')?.[1];
      if (pattern !== undefined) decided.set(pattern, cells[3] ?? '');
    }
    assert.equal(decided.size, INDEX_DEFAULT_EXCLUDES.length, 'one decision row per entry');
    for (const entry of INDEX_DEFAULT_EXCLUDES) {
      assert.equal(decided.get(entry.pattern), entry.appliesToTracked ? 'TRACKED-OK' : 'UNTRACKED-ONLY', entry.pattern);
    }
  });
});

describe('every default means the same to the installed git and to the fake rule evaluation', () => {
  it('git (--others --exclude <pattern>) and the fake agree on each entry, for a sample, a nested sample and the controls', async (t) => {
    const samples = INDEX_DEFAULT_EXCLUDES.map((entry) => defaultSamples(entry));
    const working: Record<string, string> = { 'keep.ts': 'export const keep = 1;\n' };
    for (const s of samples) for (const rel of [...s.untracked, ...s.keptUntracked]) working[rel] = 'x\n';
    const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: {}, working } });
    t.after(() => repo.cleanup());

    for (const s of samples) {
      const result = await setupRunner.run({
        executable: 'git',
        args: ['ls-files', '-z', '--others', '--exclude', s.entry.pattern],
        cwd: repo.dir,
        env: repo.envOverlay,
      });
      assert.equal(result.ok, true, decoder.decode(result.stderr));
      const listed = new Set(decoder.decode(result.stdout).split('\0').filter((p) => p !== ''));
      for (const rel of s.untracked) {
        assert.equal(listed.has(rel), false, `git must exclude ${rel} with ${s.entry.pattern}`);
        assert.equal(defaultsExclude(rel, 'all'), true, `the fake must exclude ${rel}`);
      }
      for (const rel of s.keptUntracked) {
        assert.equal(listed.has(rel), true, `git must keep ${rel} with ${s.entry.pattern}`);
        assert.equal(defaultsExclude(rel, 'all'), false, `the fake must keep ${rel}`);
      }
    }
  });

  it('tracked scope: the fake excludes a tracked sample exactly for the appliesToTracked entries', () => {
    for (const entry of INDEX_DEFAULT_EXCLUDES) {
      const s = defaultSamples(entry);
      for (const rel of s.tracked) assert.equal(defaultsExclude(rel, 'tracked'), entry.appliesToTracked, `${entry.pattern}: ${rel}`);
      for (const rel of s.keptTracked) assert.equal(defaultsExclude(rel, 'tracked'), false, `${entry.pattern}: ${rel}`);
    }
  });
});
