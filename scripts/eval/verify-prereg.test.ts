import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_PREREG_PATH, hashFile, PREREG_BLOCK_LABEL, PreregSchema, readPrereg, SKILL_PATH, STAGE_A_FILES } from './prereg.ts';
import type { Prereg } from './prereg.ts';
import { runCli, verifyPrereg } from './verify-prereg.ts';

const PARAMS: Prereg['params'] = {
  marginPoints: 5,
  intervalLevel: 0.95,
  resamples: 10000,
  seed: 20261018,
  runsPerCell: 3,
  citationRate: 0.8,
  citationJudgedOn: 'wilson_lower_bound',
  wilsonZ: 1.96,
  tokenCriterion: 'point',
  failureRule: 'incorrect-keep-tokens',
  concurrency: 2,
  maxBudgetUsdPerSession: 2,
  sessionWallClockMs: 600000,
  model: 'claude-test-model',
  claudeVersion: '2.1.302',
  corpusSha: 'a'.repeat(40),
  npmCiRan: true,
};

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-prereg-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function abs(rel: string): string {
  return path.join(root, ...rel.split('/'));
}

function writeFile(rel: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text);
}

/** Small stand-ins for the sixteen Stage A files, one distinct line each. */
function writeStageAStandIns(): void {
  for (const rel of STAGE_A_FILES) writeFile(rel, `// stand-in for ${rel}\n`);
}

/** Creates the stand-ins that do not exist yet, so a block can be built from their hashes. */
function ensureStageAStandIns(): void {
  for (const rel of STAGE_A_FILES) {
    if (!fs.existsSync(abs(rel))) writeFile(rel, `// stand-in for ${rel}\n`);
  }
}

function hashesOf(paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.map((rel) => [rel, hashFile(abs(rel))]));
}

function frozenA(overrides: Partial<Prereg> = {}): Prereg {
  ensureStageAStandIns();
  return {
    stage: 'A',
    status: 'Frozen',
    params: PARAMS,
    files: hashesOf(STAGE_A_FILES),
    questionSet: { count: 50, byCategory: { callers: 12, abstain: 6, other: 32 } },
    ...overrides,
  };
}

function markdownOf(value: unknown, extra = ''): string {
  return `# Pre-registration\n\nProse before the block.\n\n\`\`\`json\n{"not": "this one"}\n\`\`\`\n\n\`\`\`${PREREG_BLOCK_LABEL}\n${JSON.stringify(value, null, 2)}\n\`\`\`\n${extra}`;
}

function writePrereg(value: unknown, rel = DEFAULT_PREREG_PATH): string {
  writeFile(rel, markdownOf(value));
  return abs(rel);
}

function stageB(): Prereg {
  writeFile(SKILL_PATH, '---\nname: gsd-atlas\n---\nUse atlas for symbol questions.\n');
  return frozenA({
    stage: 'B',
    stageB: { skillSha256: hashFile(abs(SKILL_PATH)), atlasCommit: 'b'.repeat(40) },
  });
}

describe('STAGE_A_FILES', () => {
  test('STAGE_A_FILES lists exactly sixteen distinct repository-relative paths', () => {
    assert.equal(STAGE_A_FILES.length, 16);
    assert.equal(new Set(STAGE_A_FILES).size, 16);
    for (const rel of STAGE_A_FILES) assert.ok(!rel.startsWith('/') && !rel.includes('\\') && !rel.includes('..'), rel);
    for (const name of ['stats.ts', 'rows.ts', 'analyze.ts', 'prereg.ts']) assert.ok(STAGE_A_FILES.includes(`scripts/eval/${name}`));
  });
});

describe('hashFile', () => {
  test('hashFile is the lower-case hex sha256 of the bytes (abc)', () => {
    writeFile('abc.txt', 'abc');
    assert.equal(hashFile(abs('abc.txt')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('CRLF hashes the same as LF, and a lone CR is left alone', () => {
    writeFile('lf.txt', 'one\ntwo\nthree\n');
    writeFile('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
    assert.equal(hashFile(abs('lf.txt')), hashFile(abs('crlf.txt')));
    writeFile('cr.txt', 'one\rtwo\n');
    assert.notEqual(hashFile(abs('cr.txt')), hashFile(abs('lf.txt')));
    writeFile('other.txt', 'one\ntwo\nthree');
    assert.notEqual(hashFile(abs('other.txt')), hashFile(abs('lf.txt')));
  });
});

describe('readPrereg', () => {
  test('readPrereg extracts the single prereg-json block and ignores other fences', () => {
    const file = writePrereg(frozenA());
    const value = readPrereg(file);
    assert.equal(value.stage, 'A');
    assert.equal(value.params.citationJudgedOn, 'wilson_lower_bound');
    assert.deepEqual(Object.keys(value.files).sort(), [...STAGE_A_FILES].sort());
  });

  test('readPrereg reads a file with CRLF line endings', () => {
    const file = writePrereg(frozenA());
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    assert.equal(readPrereg(file).stage, 'A');
  });

  test('readPrereg throws for zero blocks and for two blocks', () => {
    writeFile('none.md', '# nothing here\n\n```json\n{}\n```\n');
    assert.throws(() => readPrereg(abs('none.md')), /no prereg-json block/);
    writeFile('two.md', markdownOf(frozenA(), markdownOf(frozenA())));
    assert.throws(() => readPrereg(abs('two.md')), /2 prereg-json blocks/);
  });

  test('readPrereg throws a clear error for invalid JSON and for an unterminated block', () => {
    writeFile('bad.md', '```prereg-json\n{ not json\n```\n');
    assert.throws(() => readPrereg(abs('bad.md')), /not valid JSON/);
    writeFile('open.md', '```prereg-json\n{}\n');
    assert.throws(() => readPrereg(abs('open.md')), /not closed/);
  });

  test('missing citationJudgedOn is a schema error that names the field', () => {
    const { citationJudgedOn: _omitted, ...rest } = PARAMS;
    const file = writePrereg({ ...frozenA(), params: rest });
    assert.throws(() => readPrereg(file), /params\.citationJudgedOn/);
    const parsed = PreregSchema.safeParse({ ...frozenA(), params: rest });
    assert.equal(parsed.success, false);
  });

  test('unknown citationJudgedOn value is a schema error that names the field', () => {
    for (const bad of ['both', 'Wilson', '', 'point']) {
      const file = writePrereg({ ...frozenA(), params: { ...PARAMS, citationJudgedOn: bad } });
      assert.throws(() => readPrereg(file), /params\.citationJudgedOn/, `value ${JSON.stringify(bad)}`);
    }
  });

  test('readPrereg rejects an unknown key, a bad hash and a question count that disagrees with its categories', () => {
    assert.throws(() => readPrereg(writePrereg({ ...frozenA(), extra: 1 })), /extra|Unrecognized/i);
    assert.throws(() => readPrereg(writePrereg({ ...frozenA(), files: { 'a.ts': 'XYZ' } })), /files/);
    assert.throws(() => readPrereg(writePrereg(frozenA({ questionSet: { count: 50, byCategory: { callers: 10 } } }))), /byCategory/);
  });

  test('a Stage B block without the stageB record and a Stage A block with one are schema errors', () => {
    assert.throws(() => readPrereg(writePrereg(frozenA({ stage: 'B' }))), /stageB/);
    assert.throws(() => readPrereg(writePrereg(frozenA({ stageB: { skillSha256: 'c'.repeat(64), atlasCommit: 'd'.repeat(40) } }))), /stageB/);
  });
});

describe('PreregSchema revision chain (plan 03-38)', () => {
  const COMMIT = 'c'.repeat(40);

  /** One superseded record: what a reopen writes for the record it replaces. */
  function entry(revision: number, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      revision,
      status: 'Status: Frozen (Stage A, 2026-10-18, by Test Reviewer)',
      frozenAtCommit: COMMIT,
      params: PARAMS,
      questionSet: { count: 50, byCategory: { callers: 12, abstain: 6, other: 32 } },
      files: Object.fromEntries(STAGE_A_FILES.map((rel) => [rel, 'e'.repeat(64)])),
      ...over,
    };
  }

  function revised(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...frozenA(), revision: 1, supersedes: [entry(0)], ...over };
  }

  test('a record with revision and a matching supersedes chain parses, and keeps both fields', () => {
    const parsed = readPrereg(writePrereg(revised()));
    assert.equal(parsed.revision, 1);
    assert.equal(parsed.supersedes?.length, 1);
    assert.equal(parsed.supersedes?.[0]?.revision, 0);
    assert.equal(parsed.supersedes?.[0]?.status, 'Status: Frozen (Stage A, 2026-10-18, by Test Reviewer)');
    assert.equal(parsed.supersedes?.[0]?.frozenAtCommit, COMMIT);
    assert.equal(Object.keys(parsed.supersedes?.[0]?.files ?? {}).length, STAGE_A_FILES.length);
  });

  test('a two-revision chain numbered 0 and 1 parses', () => {
    const parsed = readPrereg(writePrereg(revised({ revision: 2, supersedes: [entry(0), entry(1)] })));
    assert.equal(parsed.supersedes?.length, 2);
  });

  test('a record without either field parses exactly as before', () => {
    const parsed = readPrereg(writePrereg(frozenA()));
    assert.equal(parsed.revision, undefined);
    assert.equal(parsed.supersedes, undefined);
    assert.equal(PreregSchema.safeParse(stageB()).success, true);
  });

  test('revision without supersedes, and supersedes without revision, are refused and name the field', () => {
    const { supersedes: _s, ...noChain } = revised();
    assert.throws(() => readPrereg(writePrereg(noChain)), /supersedes/);
    const { revision: _r, ...noRevision } = revised();
    assert.throws(() => readPrereg(writePrereg(noRevision)), /revision/);
  });

  test('a chain whose length differs from the revision is refused', () => {
    assert.throws(() => readPrereg(writePrereg(revised({ revision: 2 }))), /supersedes/);
    assert.throws(() => readPrereg(writePrereg(revised({ supersedes: [entry(0), entry(1)] }))), /supersedes/);
    assert.throws(() => readPrereg(writePrereg(revised({ supersedes: [] }))), /supersedes/);
  });

  test('entries must be numbered from 0 in order', () => {
    assert.throws(() => readPrereg(writePrereg(revised({ supersedes: [entry(1)] }))), /supersedes\.0\.revision/);
    assert.throws(() => readPrereg(writePrereg(revised({ revision: 2, supersedes: [entry(1), entry(0)] }))), /supersedes\.0\.revision/);
  });

  test('revision must be a positive integer', () => {
    assert.throws(() => readPrereg(writePrereg(revised({ revision: 0, supersedes: [] }))), /revision/);
    assert.throws(() => readPrereg(writePrereg(revised({ revision: 1.5 }))), /revision/);
  });

  test('a non-hex frozenAtCommit and a malformed hash are refused and name the offending field', () => {
    assert.throws(() => readPrereg(writePrereg(revised({ supersedes: [entry(0, { frozenAtCommit: 'main' })] }))), /supersedes\.0\.frozenAtCommit/);
    assert.throws(
      () => readPrereg(writePrereg(revised({ supersedes: [entry(0, { files: { 'scripts/eval/arms.ts': 'XYZ' } })] }))),
      /supersedes\.0\.files/,
    );
  });

  test('an entry carries the superseded params and question set, which are validated like the live ones', () => {
    const { citationJudgedOn: _omitted, ...rest } = PARAMS;
    assert.throws(() => readPrereg(writePrereg(revised({ supersedes: [entry(0, { params: rest })] }))), /supersedes\.0\.params\.citationJudgedOn/);
    assert.throws(
      () => readPrereg(writePrereg(revised({ supersedes: [entry(0, { questionSet: { count: 50, byCategory: { callers: 1 } } })] }))),
      /supersedes\.0\.questionSet/,
    );
    assert.throws(() => readPrereg(writePrereg(revised({ supersedes: [entry(0, { status: '' })] }))), /supersedes\.0\.status/);
  });

  test('verifyPrereg reads a revised Frozen record and a revised Draft like any other record', () => {
    writeStageAStandIns();
    assert.deepEqual(verifyPrereg(writePrereg(revised()), root).problems, []);
    const draft = writePrereg(revised({ status: 'Draft', files: {} }));
    const result = verifyPrereg(draft, root);
    assert.equal(result.ok, true);
    assert.ok(result.notes.length > 0, 'a Draft carries notes');
    assert.equal(verifyPrereg(draft, root, { draft: true }).ok, true);
  });
});

describe('verifyPrereg', () => {
  test('matching hashes: a Frozen Stage A block whose hashes match is ok', () => {
    writeStageAStandIns();
    const result = verifyPrereg(writePrereg(frozenA()), root);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
  });

  test('changed file: one changed byte in any registered file is a problem naming that path', () => {
    writeStageAStandIns();
    const file = writePrereg(frozenA());
    for (const rel of STAGE_A_FILES) {
      const original = fs.readFileSync(abs(rel));
      const changed = Buffer.from(original);
      changed[0] = changed[0] === 0x2f ? 0x2e : 0x2f; // flip one byte
      fs.writeFileSync(abs(rel), changed);
      const result = verifyPrereg(file, root);
      assert.equal(result.ok, false, rel);
      assert.ok(result.problems.some((problem) => problem.includes(rel) && /changed/.test(problem)), `${rel}: ${result.problems.join('; ')}`);
      fs.writeFileSync(abs(rel), original);
      assert.equal(verifyPrereg(file, root).ok, true, `restoring ${rel}`);
    }
  });

  test('missing file: a Frozen block with a registered file absent is a problem naming the path', () => {
    writeStageAStandIns();
    const file = writePrereg(frozenA());
    fs.rmSync(abs('scripts/eval/oracle.ts'));
    const result = verifyPrereg(file, root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('scripts/eval/oracle.ts') && /missing/.test(problem)));
  });

  test('CRLF hashes the same: rewriting a registered file with CRLF line endings keeps the freeze ok', () => {
    writeStageAStandIns();
    writeFile('scripts/eval/stats.ts', 'line one\nline two\n');
    const file = writePrereg(frozenA());
    writeFile('scripts/eval/stats.ts', 'line one\r\nline two\r\n');
    assert.equal(verifyPrereg(file, root).ok, true);
  });

  test('frozen without hashes: a Frozen block with no file hashes is a problem', () => {
    writeStageAStandIns();
    const result = verifyPrereg(writePrereg(frozenA({ files: {} })), root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /lacks its hashes/.test(problem)));
  });

  test('a STAGE_A_FILES path left out of a Frozen block is a problem naming it', () => {
    writeStageAStandIns();
    const files = hashesOf(STAGE_A_FILES.filter((rel) => rel !== 'scripts/eval/harness.ts'));
    const result = verifyPrereg(writePrereg(frozenA({ files })), root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('scripts/eval/harness.ts') && /not registered/.test(problem)));
  });

  test('stage B without stage A: a Stage B record whose Stage A is not frozen is a problem', () => {
    writeStageAStandIns();
    const record = stageB();
    const result = verifyPrereg(writePrereg({ ...record, files: {} }), root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /Stage B/.test(problem) && /not frozen/.test(problem)), result.problems.join('; '));
  });

  test('stage B with a frozen Stage A and a matching skill hash is ok', () => {
    writeStageAStandIns();
    const record = stageB();
    const result = verifyPrereg(writePrereg(record), root);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
  });

  test('stage B: a changed skill file is a problem naming the skill path', () => {
    writeStageAStandIns();
    const file = writePrereg(stageB());
    writeFile(SKILL_PATH, 'tuned after the freeze\n');
    const result = verifyPrereg(file, root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes(SKILL_PATH) && /changed/.test(problem)));
  });

  test('stage B: a missing skill file is a problem, and a bad atlasCommit is a schema error', () => {
    writeStageAStandIns();
    const file = writePrereg(stageB());
    fs.rmSync(abs(SKILL_PATH));
    assert.ok(verifyPrereg(file, root).problems.some((problem) => problem.includes(SKILL_PATH) && /missing/.test(problem)));
    const bad = frozenA({ stage: 'B', stageB: { skillSha256: 'c'.repeat(64), atlasCommit: 'xyz' } });
    assert.ok(verifyPrereg(writePrereg(bad), root).problems.some((problem) => /atlasCommit/.test(problem)));
  });

  test('draft mode: only internal consistency is checked, so absent files are fine', () => {
    const file = writePrereg(frozenA({ files: Object.fromEntries(STAGE_A_FILES.map((rel) => [rel, 'e'.repeat(64)])) }));
    fs.rmSync(abs('scripts'), { recursive: true }); // none of the registered files exists any more
    assert.equal(verifyPrereg(file, root, { draft: true }).ok, true);
    const strict = verifyPrereg(file, root);
    assert.equal(strict.ok, false); // without draft the same block fails on the missing files
    assert.ok(strict.problems.some((problem) => /missing/.test(problem)));
  });

  test('draft mode still reports a schema error and an inconsistent block', () => {
    const { citationJudgedOn: _omitted, ...rest } = PARAMS;
    const result = verifyPrereg(writePrereg({ ...frozenA(), params: rest }), root, { draft: true });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /params\.citationJudgedOn/.test(problem)));
    assert.equal(verifyPrereg(writePrereg(frozenA({ files: {} })), root, { draft: true }).ok, false);
  });

  test('a Draft block is valid with a note when registered files do not exist yet', () => {
    const result = verifyPrereg(writePrereg(frozenA({ status: 'Draft', files: {} })), root);
    assert.equal(result.ok, true);
    assert.ok(result.notes.length > 0);
    assert.ok(result.notes.some((note) => note.includes('scripts/eval/oracle.ts')));
  });

  test('a Draft block with a recorded hash that no longer matches is still a problem', () => {
    writeStageAStandIns();
    const files = { 'scripts/eval/stats.ts': 'f'.repeat(64) };
    const result = verifyPrereg(writePrereg(frozenA({ status: 'Draft', files })), root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('scripts/eval/stats.ts')));
  });

  test('a registered path that leaves the repository root is a problem and is never read', () => {
    writeStageAStandIns();
    const files = { ...hashesOf(STAGE_A_FILES), '../outside.txt': 'a'.repeat(64) };
    const result = verifyPrereg(writePrereg(frozenA({ files })), root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('../outside.txt') && /outside/.test(problem)));
  });

  test('an absent or unreadable prereg file is a problem, not an exception', () => {
    const result = verifyPrereg(abs('docs/eval/nope.md'), root);
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 1);
  });
});

describe('verify-prereg command', () => {
  function capture(argv: string[]): { code: number; out: string; err: string } {
    let out = '';
    let err = '';
    const code = runCli(argv, { out: (text) => (out += text), err: (text) => (err += text) }, root);
    return { code, out, err };
  }

  test('matching hashes: exit 0 and an ok line', () => {
    writeStageAStandIns();
    writePrereg(frozenA());
    const result = capture([]);
    assert.equal(result.code, 0);
    assert.match(result.out, /ok/);
  });

  test('changed file: exit 1 and the problems printed one per line', () => {
    writeStageAStandIns();
    writePrereg(frozenA());
    fs.appendFileSync(abs('scripts/eval/stats.ts'), 'tampered\n');
    fs.rmSync(abs('scripts/eval/rows.ts'));
    const result = capture(['--prereg', DEFAULT_PREREG_PATH]);
    assert.equal(result.code, 1);
    const lines = result.err.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines.some((line) => line.includes('scripts/eval/stats.ts')));
    assert.ok(lines.some((line) => line.includes('scripts/eval/rows.ts')));
  });

  test('no prereg file without --draft: exit 2 and a message naming docs/eval/preregistration.md', () => {
    const result = capture([]);
    assert.equal(result.code, 2);
    assert.match(result.err, /docs\/eval\/preregistration\.md/);
  });

  test('draft mode: an absent prereg file is nothing to check, exit 0', () => {
    const result = capture(['--draft']);
    assert.equal(result.code, 0);
    assert.match(result.out, /docs\/eval\/preregistration\.md/);
  });

  test('draft mode checks an existing block without reading the registered files', () => {
    writePrereg(frozenA());
    fs.rmSync(abs('scripts'), { recursive: true });
    assert.equal(capture(['--draft']).code, 0);
    assert.equal(capture([]).code, 1);
  });

  test('usage errors exit 2: an unknown flag, a missing value, a stray argument', () => {
    assert.equal(capture(['--nope']).code, 2);
    assert.equal(capture(['--prereg']).code, 2);
    assert.equal(capture(['extra']).code, 2);
  });
});
