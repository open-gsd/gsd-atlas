/**
 * The no-break trace (plan 03-27, D-21, D-22): `precise-gate.ts --nobreak` over a repository whose packages the compiler can
 * hold in memory and one it can not. The fixture is generated: four packages, each with its own tsconfig, one of them with
 * enough source that its program passes a memory limit the other three stay under.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { createTempGitRepo } from '../src/test-kit/index.ts';
import type { TempGitRepo } from '../src/test-kit/index.ts';
import {
  BUILD_PR_CEILING_MS,
  BUILD_STRICT_MS,
  UPDATE_PR_CEILING_MS,
  UPDATE_STRICT_MS,
  WARM_QUERY_PR_CEILING_MS,
  WARM_QUERY_STRICT_MS,
  evaluate,
  main,
  runNoBreak,
  runUpdate,
} from './precise-gate.ts';
import type { GateRun, NoBreakReport } from './precise-gate.ts';

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
    // Calibrate on this machine with a limit nothing reaches: the worker's resident memory after each package's answer. The
    // reads are what is measured here, so the build does not run the eager pass (plan 03-29, `lazy`): each read meets a cold
    // cache and builds the program of its package.
    calibration = await run({ lazy: true });
    const rss = calibration.answers.map((answer) => answer.workerRssMb ?? 0);
    const afterSmall = rss[SMALL.length - 1] ?? 0;
    const afterBig = rss[SMALL.length] ?? 0;
    assert.ok(afterBig - afterSmall >= 40, `the big package must be clearly bigger than the rest: ${JSON.stringify(rss)}`);
    // Between the two: the small packages fit, the big one does not.
    limitMb = Math.ceil((afterSmall + afterBig) / 2);
    bounded = await run({ lazy: true, precise: { rssLimitMb: limitMb, sampleMs: 50 } });
    console.log('DIAG', JSON.stringify({ rss, limitMb, calibration: calibration.answers.map((a) => [a.package, a.outcome, a.workerRssMb, a.peakRssMb, a.ms]), bounded: bounded.answers.map((a) => [a.package, a.outcome, a.degraded, a.workerRssMb, a.peakRssMb, a.ms]), workers: bounded.workers, machine: bounded.machine, budget: bounded.budget }));
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

  it('the eager pass under the same limit: the build succeeds, nothing crashes, the worker stays inside its limit and the big package is memory_budget', async () => {
    // Plan 03-29: the build asks the compiler about every site, in path order. The three small packages come first, then the
    // big one, whose program the limit stops. The stop is a memory_budget answer, never a failed build or a crashed Host.
    const eager = await run({ precise: { rssLimitMb: limitMb, sampleMs: 50 } });
    assert.equal(eager.crashed, 0, JSON.stringify(eager));
    assert.equal(eager.unexplained, 0, JSON.stringify(eager));
    assert.equal(eager.workers.withinLimit, true, JSON.stringify(eager.workers));
    assert.equal(eager.ok, true, JSON.stringify(eager));
    const big = eager.answers.find((answer) => answer.package === `packages/${BIG}`);
    assert.ok(big !== undefined);
    assert.equal(big.outcome, 'degraded', JSON.stringify(big));
    assert.ok(big.degraded.includes('memory_budget'), JSON.stringify(big.degraded));
    for (const answer of eager.answers) assert.ok(answer.outcome === 'resolved' || answer.outcome === 'degraded', JSON.stringify(answer));
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

/** The part of gsd-core the update measure edits: `compareSemverCore` in `src/semver-compare.cts`, called from another file. */
const UPDATE_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'fixture-update', private: true }),
  'tsconfig.json': TSCONFIG,
  'src/semver-compare.cts': 'export function compareSemverCore(a: string, b: string): number {\n  return a < b ? -1 : a > b ? 1 : 0;\n}\n',
  'src/caller.cts': "import { compareSemverCore } from './semver-compare.cjs';\nexport function newest(a: string, b: string): string {\n  return compareSemverCore(a, b) >= 0 ? a : b;\n}\n",
};

describe('--update (plan 03-29, TSM-06): the time from saving one file to a precise answer that reflects it', () => {
  let updateRepo: TempGitRepo;
  before(async () => {
    updateRepo = await createTempGitRepo({ runner: createRealRunner({ decide: allowAll }), world: { committed: UPDATE_FILES } });
  });
  after(() => {
    updateRepo.cleanup();
  });

  it('edits one .cts file of a copy, waits for the answer that reflects it and reports the milliseconds, leaving the checkout alone', async () => {
    const before = fs.readFileSync(path.join(updateRepo.dir, 'src', 'semver-compare.cts'), 'utf8');
    const report = await runUpdate({ corpus: 'gsd-core', dir: updateRepo.dir, maxWaitMs: 60_000, env: updateRepo.envOverlay });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.symbol, 'compareSemverCore');
    assert.equal(typeof report.editToPreciseMs, 'number');
    assert.ok((report.editToPreciseMs ?? Number.POSITIVE_INFINITY) < 60_000);
    assert.ok(report.before.precise >= 1, 'a precise reference before the edit');
    assert.equal(report.after.precise, report.before.precise + 1, 'the probe function adds one precise reference');
    assert.equal(report.probe.tier, 'precise');
    assert.equal(report.probe.confidence, 'EXTRACTED');
    assert.ok(report.worker.programs >= 1);
    assert.ok(report.updates >= 1, 'the worker was told about the edit');
    assert.equal(fs.readFileSync(path.join(updateRepo.dir, 'src', 'semver-compare.cts'), 'utf8'), before, 'the checkout was not edited, its copy was');
  });

  it('exits 2 with a usage line without --dir, for an unknown corpus and with another mode', async () => {
    for (const argv of [['--update', '--corpus', 'gsd-core'], ['--update', '--corpus', 'nosuch', '--dir', updateRepo.dir], ['--update', '--trace', '--corpus', 'gsd-core', '--dir', updateRepo.dir]]) {
      const out = { written: [] as string[], write(text: string): boolean { return (this.written.push(text), true); } };
      const err = { written: [] as string[], write(text: string): boolean { return (this.written.push(text), true); } };
      assert.equal(await main(argv, { stdout: out, stderr: err }), 2, argv.join(' '));
      assert.match(err.written.join(''), /usage:/);
      assert.equal(out.written.length, 0);
    }
  });
});

describe('--nobreak command line', () => {
  const sink = () => {
    const written: string[] = [];
    return { written, write: (text: string): boolean => (written.push(text), true) };
  };

  it('exits 2 with a usage line for a missing corpus, a bad budget, and both modes at once', async () => {
    for (const argv of [
      ['--nobreak'],
      ['--nobreak', '--corpus', 'gsd-pi', '--dir', path.join(repo.dir, 'no-such-checkout')],
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

  it('without --dir the pinned corpus is fetched, traced and removed (the nightly gsd-pi step)', async () => {
    const calls: string[] = [];
    const report = { ok: true, answers: [] } as unknown as NoBreakReport;
    const out = sink();
    const err = sink();
    const code = await main(
      ['--nobreak', '--corpus', 'gsd-pi'],
      { stdout: out, stderr: err },
      {
        fetchCheckout: (corpus, prepared) => {
          calls.push(`fetch ${corpus} ${String(prepared)}`);
          return Promise.resolve({ dir: repo.dir, cleanup: () => void calls.push('cleanup') });
        },
        runNoBreak: (options) => {
          calls.push(`trace ${options.corpus} ${path.basename(options.dir) === path.basename(fs.realpathSync.native(repo.dir)) ? 'in the fetched checkout' : options.dir}`);
          return Promise.resolve(report);
        },
      },
    );
    assert.equal(code, 0, err.written.join(''));
    assert.deepStrictEqual(calls, ['fetch gsd-pi false', 'trace gsd-pi in the fetched checkout', 'cleanup']);

    // A fetch that fails is a failed gate with the reason, not a pass, and nothing is traced.
    const failed = sink();
    const failedErr = sink();
    assert.equal(
      await main(['--nobreak', '--corpus', 'gsd-pi'], { stdout: failed, stderr: failedErr }, { fetchCheckout: () => Promise.reject(new Error('fetch_failed: offline')), runNoBreak: () => Promise.reject(new Error('must not run')) }),
      1,
    );
    assert.match(failedErr.written.join(''), /precise-gate: fetch_failed: offline/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The gate (plan 03-30, D-10, TSM-06): build, one-file update and warm query, judged against a tier.

const CONSTANTS_FILE = path.resolve(import.meta.dirname, '..', '.planning', 'phases', '03-typescript-module-and-mvp-eval', '03-CONSTANTS.md');

/** The proposed value of a `gate.*` row of 03-CONSTANTS.md (Status: Approved), read from the file. */
function approvedRow(key: string): number {
  const text = fs.readFileSync(CONSTANTS_FILE, 'utf8');
  assert.match(text, /^Status: Approved/m, '03-CONSTANTS.md must be approved');
  const match = new RegExp(`\\| \`${key.replaceAll('.', '\\.')}\` \\| (\\d+) \\|`).exec(text);
  assert.ok(match !== null, `${key} is not a row of 03-CONSTANTS.md`);
  return Number(match[1]);
}

const capture = () => {
  const written: string[] = [];
  return { written, write: (text: string): boolean => (written.push(text), true) };
};

const rep = (value: number, times: number): number[] => Array.from({ length: times }, () => value);

describe('evaluate (the pure judgement)', () => {
  it('pr tier uses median and p95', () => {
    // One slow update sample out of five does not matter: the median is the third value (nearest rank).
    const slowOne = evaluate({ buildMs: 20_000, updateMs: [100, 20_000, 300, 400, 500], warmMs: [...rep(50, 9), 5000] }, 'pr');
    assert.equal(slowOne.tier, 'pr');
    assert.equal(slowOne.ok, true, JSON.stringify(slowOne));
    const update = slowOne.verdicts.find((verdict) => verdict.budget === 'update');
    assert.ok(update !== undefined);
    assert.equal(update.statistic, 'median');
    assert.equal(update.valueMs, 400);
    assert.equal(update.key, 'gate.updatePrCeilingMs');
    assert.equal(update.ceilingMs, UPDATE_PR_CEILING_MS);
    const warm = slowOne.verdicts.find((verdict) => verdict.budget === 'warm');
    assert.ok(warm !== undefined);
    assert.equal(warm.statistic, 'p95');
    assert.equal(warm.valueMs, 5000, 'the p95 of ten samples is the tenth value');
    assert.equal(warm.key, 'gate.warmQueryPrCeilingMs');
    const build = slowOne.verdicts.find((verdict) => verdict.budget === 'build');
    assert.ok(build !== undefined);
    assert.equal(build.key, 'gate.buildPrCeilingMs');
    assert.equal(build.ceilingMs, BUILD_PR_CEILING_MS);

    // The warm p95 over its ceiling fails; a median over its ceiling fails.
    assert.equal(evaluate({ buildMs: 1, updateMs: rep(1, 5), warmMs: [...rep(50, 9), 6001] }, 'pr').ok, false);
    assert.equal(evaluate({ buildMs: 1, updateMs: [20_000, 20_000, 20_000, 1, 1], warmMs: rep(1, 10) }, 'pr').ok, false);
    // A value exactly on the ceiling passes (the bound is "within").
    assert.equal(evaluate({ buildMs: BUILD_PR_CEILING_MS, updateMs: rep(UPDATE_PR_CEILING_MS, 5), warmMs: rep(WARM_QUERY_PR_CEILING_MS, 10) }, 'pr').ok, true);
  });

  it('strict tier uses p95', () => {
    // 20 update samples: the p95 is the 19th value, so one 9 s sample passes and two fail.
    const one = evaluate({ buildMs: 11_000, updateMs: [...rep(100, 19), 9000], warmMs: rep(40, 50) }, 'strict');
    const updateOne = one.verdicts.find((verdict) => verdict.budget === 'update');
    assert.ok(updateOne !== undefined);
    assert.equal(updateOne.statistic, 'p95');
    assert.equal(updateOne.valueMs, 100);
    assert.equal(updateOne.key, 'gate.updateStrictMs');
    assert.equal(updateOne.ceilingMs, UPDATE_STRICT_MS);
    assert.equal(one.ok, true, JSON.stringify(one));
    const two = evaluate({ buildMs: 11_000, updateMs: [...rep(100, 18), 9000, 9000], warmMs: rep(40, 50) }, 'strict');
    assert.equal(two.ok, false);
    // 50 warm samples: the p95 is the 48th value.
    const warm = evaluate({ buildMs: 11_000, updateMs: rep(100, 20), warmMs: [...rep(40, 47), 2500, 2500, 2500] }, 'strict');
    assert.equal(warm.ok, false);
    assert.equal(warm.verdicts.find((verdict) => verdict.budget === 'warm')?.valueMs, 2500);
    assert.equal(warm.verdicts.find((verdict) => verdict.budget === 'warm')?.ceilingMs, WARM_QUERY_STRICT_MS);
  });

  it('a build of 30001 ms passes the pull request tier and fails the strict tier', () => {
    const measurements = { buildMs: 30_001, updateMs: rep(100, 5), warmMs: rep(40, 10) };
    assert.equal(evaluate(measurements, 'pr').ok, true);
    const strict = evaluate({ ...measurements, updateMs: rep(100, 20), warmMs: rep(40, 50) }, 'strict');
    assert.equal(strict.ok, false);
    const build = strict.verdicts.find((verdict) => verdict.budget === 'build');
    assert.equal(build?.ok, false);
    assert.equal(build?.key, 'gate.buildStrictMs');
    assert.equal(build?.ceilingMs, BUILD_STRICT_MS);
  });

  it('an empty sample list, or a sample that is not a finite number, throws: a gate that could not measure never passes', () => {
    assert.throws(() => evaluate({ buildMs: 1, updateMs: [], warmMs: rep(1, 10) }, 'pr'), /no samples/);
    assert.throws(() => evaluate({ buildMs: 1, updateMs: rep(1, 5), warmMs: [] }, 'strict'), /no samples/);
    assert.throws(() => evaluate({ buildMs: Number.NaN, updateMs: rep(1, 5), warmMs: rep(1, 10) }, 'pr'), /build/);
    assert.throws(() => evaluate({ buildMs: 1, updateMs: [1, Number.POSITIVE_INFINITY], warmMs: rep(1, 10) }, 'pr'), /update/);
  });

  it('constants equal the approved rows', () => {
    assert.equal(BUILD_PR_CEILING_MS, approvedRow('gate.buildPrCeilingMs'));
    assert.equal(UPDATE_PR_CEILING_MS, approvedRow('gate.updatePrCeilingMs'));
    assert.equal(WARM_QUERY_PR_CEILING_MS, approvedRow('gate.warmQueryPrCeilingMs'));
    assert.equal(BUILD_STRICT_MS, approvedRow('gate.buildStrictMs'));
    assert.equal(UPDATE_STRICT_MS, approvedRow('gate.updateStrictMs'));
    assert.equal(WARM_QUERY_STRICT_MS, approvedRow('gate.warmQueryStrictMs'));
  });
});

describe('the gate command line', () => {
  const fake = (over: Partial<GateRun['measurements']> = {}): GateRun => ({
    corpus: 'fixture',
    compiler: { source: 'bundled', version: '6.0.3' },
    workerPeakRssMb: 300,
    warmSymbols: 4,
    measurements: { buildMs: 12_000, updateMs: rep(300, 5), warmMs: rep(30, 10), ...over },
  });
  const lastJson = (out: { written: string[] }): Record<string, unknown> => JSON.parse(out.written.join('').trim().split('\n').pop() ?? '') as Record<string, unknown>;

  it('unknown flag is a usage error', async () => {
    for (const argv of [
      ['--pr', '--corpus', 'fixture', '--ceiling-build-ms', '999999'],
      ['--strict', '--corpus', 'fixture', '--max-ms', '1'],
      ['--pr', '--strict', '--corpus', 'fixture'],
      ['--pr', '--trace', '--corpus', 'fixture'],
      ['--pr', '--corpus', 'nosuch'],
      ['--pr'],
      ['--pr', '--corpus', 'fixture', '--samples-update', '0'],
    ]) {
      const out = capture();
      const err = capture();
      assert.equal(await main(argv, { stdout: out, stderr: err }, { run: () => Promise.reject(new Error('must not run')) }), 2, argv.join(' '));
      assert.match(err.written.join(''), /usage:/, argv.join(' '));
      assert.equal(out.written.length, 0);
    }
  });

  it('forced breach exits 1 through the command, and the verdict names the key and the ceiling', async () => {
    const out = capture();
    const err = capture();
    const code = await main(['--pr', '--corpus', 'fixture'], { stdout: out, stderr: err }, { run: () => Promise.resolve(fake({ buildMs: BUILD_PR_CEILING_MS + 1 })) });
    assert.equal(code, 1);
    const report = lastJson(out) as { ok: boolean; verdicts: Array<{ budget: string; key: string; ceilingMs: number; ok: boolean }> };
    assert.equal(report.ok, false);
    const build = report.verdicts.find((verdict) => verdict.budget === 'build');
    assert.deepStrictEqual({ key: build?.key, ceilingMs: build?.ceilingMs, ok: build?.ok }, { key: 'gate.buildPrCeilingMs', ceilingMs: BUILD_PR_CEILING_MS, ok: false });
    assert.match(err.written.join(''), /gate\.buildPrCeilingMs/);

    // The same measurements within the ceilings exit 0, and the same build is judged by the tier it was run under.
    const fine = capture();
    assert.equal(await main(['--pr', '--corpus', 'fixture'], { stdout: fine, stderr: capture() }, { run: () => Promise.resolve(fake({ buildMs: 30_001 })) }), 0);
    const strict = capture();
    assert.equal(await main(['--strict', '--corpus', 'fixture'], { stdout: strict, stderr: capture() }, { run: () => Promise.resolve(fake({ buildMs: 30_001, updateMs: rep(10, 20), warmMs: rep(10, 50) })) }), 1);
    assert.equal(lastJson(strict)['tier'], 'strict');
  });

  it('a measurement that could not be taken exits 1 with the reason and prints no passing verdict', async () => {
    const out = capture();
    const err = capture();
    const code = await main(['--strict', '--corpus', 'fixture'], { stdout: out, stderr: err }, { run: () => Promise.reject(new Error('build failed: tier_unavailable')) });
    assert.equal(code, 1);
    assert.match(err.written.join(''), /precise-gate: build failed: tier_unavailable/);
    assert.equal(out.written.length, 0);
  });

  it('fixture run', async () => {
    const out = capture();
    const err = capture();
    const code = await main(['--pr', '--corpus', 'fixture'], { stdout: out, stderr: err });
    assert.equal(code, 0, `${err.written.join('')}${out.written.join('')}`);
    const report = lastJson(out) as {
      tier: string;
      corpus: string;
      ok: boolean;
      buildMs: number;
      updateMs: number[];
      warmMs: number[];
      compiler: { source: string; version: string } | null;
      verdicts: Array<{ ok: boolean }>;
    };
    assert.equal(report.tier, 'pr');
    assert.equal(report.corpus, 'fixture');
    assert.equal(report.ok, true);
    assert.equal(typeof report.buildMs, 'number');
    assert.equal(report.updateMs.length, 5, 'five one-file updates in the pull request tier');
    assert.equal(report.warmMs.length, 10, 'ten warm queries in the pull request tier');
    assert.ok(report.updateMs.every((value) => Number.isFinite(value) && value >= 0));
    assert.ok(report.warmMs.every((value) => Number.isFinite(value) && value >= 0));
    assert.ok(report.compiler !== null, 'the compiler source and version are printed');
    assert.match(report.compiler.version, /^\d+\.\d+\.\d+/);
    assert.equal(report.compiler.source, 'bundled', 'no dependency install: the bundled compiler');
    assert.equal(report.verdicts.length, 3);
  });
});
