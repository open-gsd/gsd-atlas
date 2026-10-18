import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ORACLE_VERSION, OracleError, computeAnswerKey, type OracleContext } from './oracle.ts';
import { AnswerKeySchema, QuestionFileSchema, loadQuestions, type KeySpec } from './questions.ts';

const FIXTURE = path.join(import.meta.dirname, '__fixtures__', 'oracle-repo');

function fixtureCtx(): OracleContext {
  return { repoDir: FIXTURE, tsconfig: 'tsconfig.json' };
}

const COMMON = { granularity: 'file+symbol', equality: 'exact-set' } as const;

function callersOfCompute(): KeySpec {
  return { kind: 'callers', symbol: 'compute', definedIn: 'src/lib.cts', ...COMMON };
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return env;
}

function run(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

interface TempRepo {
  dir: string;
  ctx: OracleContext;
  cleanup(): void;
}

/**
 * A copy of the fixture in a fresh git repository under the OS temp directory. `transform` may
 * change the text of any file (return the same text to keep it); `extra` adds files.
 */
function tempRepo(
  transform: (rel: string, text: string) => string = (_rel, text) => text,
  extra: Record<string, string> = {},
): TempRepo {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-test-')));
  for (const rel of listFiles(FIXTURE)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, transform(rel, fs.readFileSync(path.join(FIXTURE, ...rel.split('/')), 'utf8')));
  }
  for (const [rel, text] of Object.entries(extra)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  run(dir, 'git', ['init', '-q']);
  run(dir, 'git', ['add', '-A']);
  run(dir, 'git', [
    '-c',
    'user.name=oracle',
    '-c',
    'user.email=oracle@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  return {
    dir,
    ctx: { repoDir: dir, tsconfig: 'tsconfig.json' },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

describe('questions', () => {
  const valid = {
    corpusId: 'fixture',
    corpusSha: 'abc',
    questions: [{ id: 'q-1', category: 'callers', text: 'Who calls compute?', key: callersOfCompute() }],
  };

  test('accepts a well-formed question file', () => {
    assert.doesNotThrow(() => QuestionFileSchema.parse(valid));
  });

  test('rejects an unknown key kind, a missing granularity and a repeated id', () => {
    const unknownKind = structuredClone(valid) as { questions: { key: Record<string, unknown> }[] };
    unknownKind.questions[0].key.kind = 'callees';
    assert.throws(() => QuestionFileSchema.parse(unknownKind), /kind|invalid/i);

    const noGranularity = structuredClone(valid) as { questions: { key: Record<string, unknown> }[] };
    delete noGranularity.questions[0].key.granularity;
    assert.throws(() => QuestionFileSchema.parse(noGranularity), /granularity/);

    const repeated = structuredClone(valid);
    repeated.questions.push({ ...repeated.questions[0] });
    assert.throws(() => QuestionFileSchema.parse(repeated), /duplicate question id q-1/);
  });

  test('rejects a category that disagrees with the key kind and an absolute path', () => {
    const wrongCategory = structuredClone(valid);
    wrongCategory.questions[0].category = 'emit';
    assert.throws(() => QuestionFileSchema.parse(wrongCategory), /does not match key kind/);

    const absolute = structuredClone(valid) as { questions: { key: Record<string, unknown> }[] };
    absolute.questions[0].key.definedIn = '/etc/passwd';
    assert.throws(() => QuestionFileSchema.parse(absolute), /repository-relative/);
  });

  test('loadQuestions reads a file and surfaces the zod message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-questions-'));
    try {
      const good = path.join(dir, 'good.json');
      fs.writeFileSync(good, JSON.stringify(valid));
      assert.equal(loadQuestions(good).questions.length, 1);

      const bad = path.join(dir, 'bad.json');
      const noGranularity = structuredClone(valid) as { questions: { key: Record<string, unknown> }[] };
      delete noGranularity.questions[0].key.granularity;
      fs.writeFileSync(bad, JSON.stringify(noGranularity));
      assert.throws(() => loadQuestions(bad), /granularity/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('callers key', () => {
  test('callers: typed import, destructured require and a .cjs consumer, not the same-named local', async () => {
    const key = await computeAnswerKey(callersOfCompute(), fixtureCtx());
    assert.equal(key.oracleVersion, ORACLE_VERSION);
    assert.equal(key.abstain, false);
    assert.deepEqual(key.items, [
      { file: 'consumer.cjs', line: 6, symbol: 'run' },
      { file: 'src/user.cts', line: 5, symbol: 'useTyped' },
      { file: 'src/user.cts', line: 12, symbol: 'useRequire' },
    ]);
    assert.equal(new Set(key.items.map((item) => item.file)).size, 2);
    // the same-named local function in `unrelated` and its call are absent
    assert.ok(!key.items.some((item) => item.symbol === 'unrelated'));
    assert.ok(key.needles.includes('compute'));
    assert.ok(key.needles.includes('calc'), `needles: ${key.needles.join(',')}`);
  });

  test('callers: every git grep mention is classified, so unexplained is empty', async () => {
    const key = await computeAnswerKey(callersOfCompute(), fixtureCtx());
    assert.deepEqual(key.unexplained, []);
  });

  test('callers: the answer key parses with AnswerKeySchema and carries no absolute path', async () => {
    const key = await computeAnswerKey(callersOfCompute(), fixtureCtx());
    assert.doesNotThrow(() => AnswerKeySchema.parse(key));
    for (const item of key.items) {
      assert.ok(item.file !== undefined && !item.file.startsWith('/') && !/^[A-Za-z]:/.test(item.file));
    }
  });

  test('callers: a symbol that is not declared in definedIn throws a typed error', async () => {
    await assert.rejects(
      computeAnswerKey({ ...callersOfCompute(), symbol: 'nope' } as KeySpec, fixtureCtx()),
      (error: unknown) => error instanceof OracleError && error.code === 'SYMBOL_NOT_FOUND' && /nope/.test(error.message),
    );
    await assert.rejects(
      computeAnswerKey({ ...callersOfCompute(), definedIn: 'src/missing.cts' } as KeySpec, fixtureCtx()),
      (error: unknown) => error instanceof OracleError && error.code === 'FILE_NOT_IN_PROGRAM',
    );
  });

  test('callers: a same-named mention the oracle cannot classify is reported as unexplained', async () => {
    const repo = tempRepo(undefined, {
      'src/other.cts': "import { compute } from './lib.cjs';\nexport const viaCallback = [1].map(compute);\n",
    });
    try {
      const key = await computeAnswerKey(callersOfCompute(), repo.ctx);
      assert.deepEqual(
        key.unexplained.map((entry) => `${entry.file}:${entry.line}`),
        ['src/other.cts:2'],
      );
      assert.ok(!key.items.some((item) => item.file === 'src/other.cts'));
    } finally {
      repo.cleanup();
    }
  });
});

describe('safety', () => {
  test('a tsconfig whose extends leaves the repository is refused', async () => {
    const repo = tempRepo((rel, text) =>
      rel === 'tsconfig.json' ? text.replace('{', '{\n  "extends": "../outside.json",') : text,
    );
    try {
      await assert.rejects(
        computeAnswerKey(callersOfCompute(), repo.ctx),
        (error: unknown) => error instanceof OracleError && error.code === 'OUTSIDE_REPO',
      );
    } finally {
      repo.cleanup();
    }
  });

  test('a tsconfig whose include leaves the repository is refused', async () => {
    const repo = tempRepo((rel, text) => (rel === 'tsconfig.json' ? text.replace('["src"]', '["src", "../other"]') : text));
    try {
      await assert.rejects(
        computeAnswerKey(callersOfCompute(), repo.ctx),
        (error: unknown) => error instanceof OracleError && error.code === 'OUTSIDE_REPO',
      );
    } finally {
      repo.cleanup();
    }
  });
});
