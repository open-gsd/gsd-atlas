/**
 * The no-break trace (plan 03-27, D-21, D-22): `precise-gate.ts --nobreak` over a repository whose packages the compiler can
 * hold in memory and one it can not. The fixture is generated: four packages, each with its own tsconfig, one of them with
 * enough source that its program passes a memory limit the other three stay under.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { createTempGitRepo } from '../src/test-kit/index.ts';
import type { TempGitRepo } from '../src/test-kit/index.ts';
import { main, runNoBreak } from './precise-gate.ts';
import type { NoBreakReport } from './precise-gate.ts';

const TSCONFIG = JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true, target: 'es2022' }, include: ['src'] }, null, 2);

/** Packages in name order: the big one is last, so a memory stop (which latches the project) comes after the small ones. */
const SMALL = ['alpha', 'beta', 'gamma'] as const;
const BIG = 'zeta';
const BIG_FILES = 400;

function generated(index: number): string {
  const lines: string[] = [`export interface Shape${String(index)} { id: number; name: string; tags: string[]; nested: { a: number; b: string; c: boolean } }`];
  for (let method = 0; method < 12; method += 1) {
    lines.push(
      `export class Gen${String(index)}_${String(method)} {`,
      `  private readonly items: Map<string, Shape${String(index)}> = new Map();`,
      `  add(shape: Shape${String(index)}): this { this.items.set(shape.name, shape); return this; }`,
      `  find(name: string): Shape${String(index)} | undefined { return this.items.get(name); }`,
      `  names(): string[] { return [...this.items.keys()].map((key) => key.toUpperCase()); }`,
      `  total(): number { let sum = 0; for (const item of this.items.values()) sum += item.id + item.nested.a; return sum; }`,
      '}',
    );
  }
  return `${lines.join('\n')}\n`;
}

function fixtureFiles(): Record<string, string> {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'fixture-root', private: true }) };
  for (const name of [...SMALL, BIG]) {
    files[`packages/${name}/package.json`] = JSON.stringify({ name });
    files[`packages/${name}/tsconfig.json`] = TSCONFIG;
    files[`packages/${name}/src/a-lib.ts`] = `export function compute_${name}(n: number): number {\n  return n + 1;\n}\n`;
    files[`packages/${name}/src/b-use.ts`] = `import { compute_${name} } from './a-lib.js';\n\nexport const out_${name} = compute_${name}(2);\n`;
  }
  for (let index = 0; index < BIG_FILES; index += 1) files[`packages/${BIG}/src/gen/f${String(index).padStart(4, '0')}.ts`] = generated(index);
  return files;
}

let repo: TempGitRepo;
before(async () => {
  repo = await createTempGitRepo({ runner: createRealRunner({ decide: allowAll }), world: { committed: fixtureFiles() } });
});
after(() => {
  repo.cleanup();
});

const run = (extra: Partial<Parameters<typeof runNoBreak>[0]> = {}): Promise<NoBreakReport> =>
  runNoBreak({ corpus: 'fixture', dir: repo.dir, order: 'name', maxWaitMs: 90_000, env: repo.envOverlay, ...extra });

describe('--nobreak (D-21, D-22)', () => {
  let calibration: NoBreakReport;
  let bounded: NoBreakReport;
  let limitMb = 0;

  before(async () => {
    // Calibrate on this machine with a limit nothing reaches: the worker's resident memory after each package's answer.
    calibration = await run();
    const rss = calibration.answers.map((answer) => answer.workerRssMb ?? 0);
    const afterSmall = rss[SMALL.length - 1] ?? 0;
    const afterBig = rss[SMALL.length] ?? 0;
    assert.ok(afterBig - afterSmall >= 40, `the big package must be clearly bigger than the rest: ${JSON.stringify(rss)}`);
    // Between the two: the small packages fit, the big one does not.
    limitMb = Math.ceil((afterSmall + afterBig) / 2);
    bounded = await run({ precise: { rssLimitMb: limitMb, sampleMs: 50 } });
  });

  it('nobreak on a multi-config fixture: four packages, one symbol each, every answer explained, exit 0', async () => {
    assert.equal(calibration.answers.length, 4);
    assert.deepStrictEqual(calibration.answers.map((answer) => answer.package), ['packages/alpha', 'packages/beta', 'packages/gamma', 'packages/zeta']);
    for (const answer of calibration.answers) {
      assert.equal(answer.outcome, 'resolved', JSON.stringify(answer));
      assert.ok(answer.tiers.includes('precise'));
      assert.equal(answer.extracted, true);
    }
    assert.equal(calibration.ok, true, JSON.stringify(calibration));

    assert.equal(bounded.ok, true, JSON.stringify(bounded));
    assert.equal(bounded.crashed, 0);
    assert.equal(bounded.unexplained, 0);
    assert.equal(bounded.workers.withinLimit, true, JSON.stringify(bounded.workers));
    assert.equal(bounded.workers.limitMb, limitMb);
    assert.ok(bounded.answers.some((answer) => answer.outcome === 'resolved'), 'at least one resolved answer');
  });

  it('too-large program degrades: the answer for the big package is grammar facts flagged memory_budget, not a failure', () => {
    const big = bounded.answers.find((answer) => answer.package === `packages/${BIG}`);
    assert.ok(big !== undefined);
    assert.equal(big.outcome, 'degraded', JSON.stringify(big));
    assert.ok(big.degraded.includes('memory_budget'), JSON.stringify(big.degraded));
    assert.deepStrictEqual(big.tiers, ['grammar']);
    assert.equal(big.extracted, false);
    for (const small of bounded.answers.filter((answer) => answer.package !== `packages/${BIG}`)) {
      assert.equal(small.outcome, 'resolved', JSON.stringify(small));
    }
  });

  it('records the figures a summary needs: the budget, the machine and a worker count', () => {
    assert.ok(bounded.machine.totalMemMb > 0);
    assert.equal(bounded.budget.usable, true);
    assert.ok(bounded.answers.every((answer) => answer.ms >= 0 && answer.workers >= 0));
    assert.ok(bounded.workers.seen >= 1);
  });

  it('a budget below the floor degrades every answer with memory_budget and starts no worker', async () => {
    const small = await run({ budgetMb: 300 });
    assert.equal(small.budget.usable, false);
    assert.equal(small.budget.budgetMb, 300);
    assert.equal(small.ok, true, JSON.stringify(small));
    assert.ok(small.answers.every((answer) => answer.outcome === 'degraded' && answer.degraded.includes('memory_budget')), JSON.stringify(small.answers));
    assert.equal(small.workers.seen, 0);
  });
});

describe('--nobreak command line', () => {
  const sink = () => {
    const written: string[] = [];
    return { written, write: (text: string): boolean => (written.push(text), true) };
  };

  it('exits 2 with a usage line for a missing directory, a bad budget, and both modes at once', async () => {
    for (const argv of [
      ['--nobreak', '--corpus', 'gsd-pi'],
      ['--nobreak', '--corpus', 'gsd-pi', '--dir', repo.dir, '--budget-mb', 'lots'],
      ['--nobreak', '--corpus', 'gsd-pi', '--dir', repo.dir, '--budget-mb', '0'],
      ['--nobreak', '--trace', '--corpus', 'gsd-pi', '--dir', repo.dir],
      ['--corpus', 'gsd-pi', '--dir', repo.dir],
    ]) {
      const out = sink();
      const err = sink();
      assert.equal(await main(argv, { stdout: out, stderr: err }), 2, argv.join(' '));
      assert.match(err.written.join(''), /usage:/);
      assert.equal(out.written.length, 0);
    }
  });
});
