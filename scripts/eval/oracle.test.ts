import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ORACLE_VERSION, OracleError, computeAnswerKey, verifyCitation, type OracleContext } from './oracle.ts';
import { AnswerFileSchema, AnswerKeySchema, QuestionFileSchema, loadQuestions, type KeySpec } from './questions.ts';

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

const REF = { granularity: 'file+line', equality: 'exact-set' } as const;
const FILE = { granularity: 'file', equality: 'exact-set' } as const;

function key(spec: KeySpec, ctx: OracleContext = fixtureCtx()) {
  return computeAnswerKey(spec, ctx);
}

describe('key kinds', () => {
  test('references: calls and non-call sites, CommonJS bindings included, definition excluded', async () => {
    const answer = await key({ kind: 'references', symbol: 'compute', definedIn: 'src/lib.cts', ...REF });
    assert.deepEqual(answer.items, [
      { file: 'consumer.cjs', line: 3, symbol: '<module>' },
      { file: 'consumer.cjs', line: 6, symbol: 'run' },
      { file: 'src/user.cts', line: 1, symbol: '<module>' },
      { file: 'src/user.cts', line: 5, symbol: 'useTyped' },
      { file: 'src/user.cts', line: 11, symbol: 'useRequire' },
      { file: 'src/user.cts', line: 12, symbol: 'useRequire' },
    ]);
    assert.deepEqual(answer.unexplained, []);
  });

  test('definition: the declaration, and every declaration of an overloaded name', async () => {
    const answer = await key({ kind: 'definition', symbol: 'compute', definedIn: 'src/lib.cts', ...REF });
    assert.deepEqual(answer.items, [{ file: 'src/lib.cts', line: 2, symbol: 'compute' }]);

    const repo = tempRepo(undefined, {
      'src/over.cts':
        'export function over(a: string): string;\nexport function over(a: number): number;\nexport function over(a: unknown): unknown {\n  return a;\n}\n',
    });
    try {
      const overloaded = await key({ kind: 'definition', symbol: 'over', ...REF }, repo.ctx);
      assert.deepEqual(
        overloaded.items.map((item) => item.line),
        [1, 2, 3],
      );
    } finally {
      repo.cleanup();
    }
  });

  test('heritage subtypes: a class, a library class and an interface', async () => {
    const base = await key({
      kind: 'heritage',
      symbol: 'Base',
      definedIn: 'src/lib.cts',
      direction: 'subtypes',
      granularity: 'file+symbol',
      equality: 'exact-set',
    });
    assert.deepEqual(base.items, [{ file: 'src/shapes.cts', line: 4, symbol: 'Sub' }]);
    assert.ok(base.needles.includes('Sub'));

    const lib = await key({
      kind: 'heritage',
      symbol: 'Error',
      lib: true,
      direction: 'subtypes',
      granularity: 'file+symbol',
      equality: 'exact-set',
    });
    assert.deepEqual(lib.items, [{ file: 'src/shapes.cts', line: 5, symbol: 'Boom' }]);

    const shape = await key({
      kind: 'heritage',
      symbol: 'Shape',
      definedIn: 'src/lib.cts',
      direction: 'subtypes',
      granularity: 'file+symbol',
      equality: 'exact-set',
    });
    assert.deepEqual(shape.items, [{ file: 'src/shapes.cts', line: 6, symbol: 'Square' }]);
  });

  test('heritage supertypes: the base class, and a library base counted in the notes', async () => {
    const sub = await key({
      kind: 'heritage',
      symbol: 'Sub',
      definedIn: 'src/shapes.cts',
      direction: 'supertypes',
      granularity: 'file+symbol',
      equality: 'exact-set',
    });
    assert.deepEqual(sub.items, [{ file: 'src/lib.cts', line: 6, symbol: 'Base' }]);

    const boom = await key({
      kind: 'heritage',
      symbol: 'Boom',
      definedIn: 'src/shapes.cts',
      direction: 'supertypes',
      granularity: 'file+symbol',
      equality: 'exact-set',
    });
    assert.deepEqual(boom.items, []);
    assert.equal(boom.notes.externalSupertypes, 'Error');
  });

  test('emit: the output path, the declaration output when enabled, and a throw outside the roots', async () => {
    const plain = await key({ kind: 'emit', source: 'src/lib.cts', ...FILE });
    assert.deepEqual(plain.items, [{ file: 'out/lib.cjs' }]);
    assert.deepEqual(plain.needles, ['lib.cjs']);

    const declared = await key(
      { kind: 'emit', source: 'src/lib.cts', ...FILE },
      { repoDir: FIXTURE, tsconfig: 'tsconfig.decl.json' },
    );
    assert.deepEqual(declared.items, [{ file: 'out/lib.cjs' }, { file: 'out/lib.d.cts' }]);

    await assert.rejects(
      key({ kind: 'emit', source: 'consumer.cjs', ...FILE }),
      (error: unknown) => error instanceof OracleError && error.code === 'EMIT_SOURCE_NOT_IN_PROGRAM',
    );
  });

  test('emit consumers: the require lines of the emitted output and of the sibling specifier', async () => {
    const answer = await key({ kind: 'emit-consumers', source: 'src/lib.cts', ...REF });
    assert.deepEqual(answer.items, [
      { file: 'consumer.cjs', line: 3 },
      { file: 'src/user.cts', line: 11 },
    ]);
  });

  test('adr citers: comments only, numbers by value, a string literal counted but excluded', async () => {
    const one = await key({ kind: 'adr-citers', number: 1, ...REF });
    assert.deepEqual(one.items, [{ file: 'src/lib.cts', line: 14 }]);
    assert.equal(one.notes.excludedNonComment, 0);

    const two = await key({ kind: 'adr-citers', number: 2, ...REF });
    assert.deepEqual(two.items, [{ file: 'src/user.cts', line: 3, detail: '§3' }]);

    const three = await key({ kind: 'adr-citers', number: 3, ...REF });
    assert.deepEqual(three.items, [{ file: 'src/user.cts', line: 8 }]);

    const nine = await key({ kind: 'adr-citers', number: 9, ...REF });
    assert.deepEqual(nine.items, []);
    assert.equal(nine.notes.excludedNonComment, 1);
    assert.deepEqual(nine.needles, ['ADR']);
  });

  test('adr of: resolved files, an unresolved citation, and two files with one number', async () => {
    const helper = await key({ kind: 'adr-of', symbol: 'helper', definedIn: 'src/lib.cts', ...FILE });
    assert.deepEqual(helper.items, [{ file: 'docs/adr/0001-first.md', adr: 1, resolved: true }]);

    const typed = await key({ kind: 'adr-of', symbol: 'useTyped', definedIn: 'src/user.cts', ...FILE });
    assert.deepEqual(typed.items, [{ file: 'docs/adr/2-second.md', adr: 2, resolved: true, detail: '§3' }]);

    const unresolved = await key({ kind: 'adr-of', symbol: 'useRequire', definedIn: 'src/user.cts', ...FILE });
    assert.deepEqual(unresolved.items, [{ adr: 3, resolved: false }]);

    const repo = tempRepo(undefined, { 'docs/adr/0001-duplicate.md': '# Duplicate\n' });
    try {
      const both = await key({ kind: 'adr-of', symbol: 'helper', definedIn: 'src/lib.cts', ...FILE }, repo.ctx);
      assert.deepEqual(
        both.items.map((item) => item.file),
        ['docs/adr/0001-duplicate.md', 'docs/adr/0001-first.md'],
      );
    } finally {
      repo.cleanup();
    }
  });

  test('impact: callers by file at depth 1, then the callers of their exported functions at depth 2', async () => {
    const one = await key({ kind: 'impact', symbol: 'compute', definedIn: 'src/lib.cts', depth: 1, ...FILE });
    assert.deepEqual(one.items, [{ file: 'consumer.cjs' }, { file: 'src/user.cts' }]);

    const two = await key({ kind: 'impact', symbol: 'compute', definedIn: 'src/lib.cts', depth: 2, ...FILE });
    assert.deepEqual(two.items, [{ file: 'consumer.cjs' }, { file: 'src/shapes.cts' }, { file: 'src/user.cts' }]);
  });

  test('abstain symbol: nothing matches, a match throws with the list, a comment-only word is tolerated', async () => {
    const none = await key({ kind: 'abstain', probe: { symbol: 'doesNotExistAnywhere' }, ...FILE });
    assert.equal(none.abstain, true);
    assert.deepEqual(none.items, []);

    await assert.rejects(
      key({ kind: 'abstain', probe: { symbol: 'compute' }, ...FILE }),
      (error: unknown) =>
        error instanceof OracleError && error.code === 'ABSTAIN_PROBE_MATCHES' && /src\/lib\.cts:2/.test(error.message),
    );

    const repo = tempRepo(undefined, { 'src/notes.cts': "// zzzOnlyInComment\nexport const text = 'zzzOnlyInString';\n" });
    try {
      assert.equal((await key({ kind: 'abstain', probe: { symbol: 'zzzOnlyInComment' }, ...FILE }, repo.ctx)).abstain, true);
      assert.equal((await key({ kind: 'abstain', probe: { symbol: 'zzzOnlyInString' }, ...FILE }, repo.ctx)).abstain, true);
    } finally {
      repo.cleanup();
    }
  });

  test('abstain adr: a number with a citation but no ADR file abstains; a number with a file throws', async () => {
    const none = await key({ kind: 'abstain', probe: { adrNoFile: 3 }, ...FILE });
    assert.equal(none.abstain, true);
    assert.deepEqual(none.items, []);
    await assert.rejects(
      key({ kind: 'abstain', probe: { adrNoFile: 1 }, ...FILE }),
      (error: unknown) => error instanceof OracleError && error.code === 'ABSTAIN_PROBE_MATCHES',
    );
  });
});

describe('verifyCitation', () => {
  test('ok when the file, the line and a needle exist; reasons otherwise', async () => {
    const ctx = fixtureCtx();
    assert.deepEqual(await verifyCitation(ctx, { file: 'src/lib.cts', line: 2 }), { ok: true });
    assert.deepEqual(await verifyCitation(ctx, { file: 'src/lib.cts', line: 2 }, ['COMPUTE', 'other']), { ok: true });
    assert.deepEqual(await verifyCitation(ctx, { file: 'src/gone.cts', line: 1 }), { ok: false, reason: 'file missing' });
    assert.deepEqual(await verifyCitation(ctx, { file: '../escape.txt', line: 1 }), { ok: false, reason: 'file missing' });
    assert.deepEqual(await verifyCitation(ctx, { file: 'src/lib.cts', line: 999 }), { ok: false, reason: 'line out of range' });
    assert.deepEqual(await verifyCitation(ctx, { file: 'src/lib.cts', line: 0 }), { ok: false, reason: 'line out of range' });
    assert.deepEqual(await verifyCitation(ctx, { file: 'src/lib.cts', line: 2 }, ['nothere']), {
      ok: false,
      reason: 'needle absent',
    });
  });

  test('the needles of a callers key accept the destructured-require alias line', async () => {
    const answer = await computeAnswerKey(callersOfCompute(), fixtureCtx());
    for (const item of answer.items) {
      const verdict = await verifyCitation(fixtureCtx(), { file: item.file as string, line: item.line as number }, answer.needles);
      assert.equal(verdict.ok, true, `${item.file}:${item.line}`);
    }
  });
});

describe('keys command', () => {
  test('writes answers that parse with the schema, for a two-question file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-cli-'));
    try {
      const questions = path.join(dir, 'questions.json');
      fs.writeFileSync(
        questions,
        JSON.stringify({
          corpusId: 'fixture',
          corpusSha: 'fixture',
          questions: [
            { id: 'q-2', category: 'definition', text: 'Where is compute?', key: { kind: 'definition', symbol: 'compute', ...REF } },
            { id: 'q-1', category: 'callers', text: 'Who calls compute?', key: callersOfCompute() },
          ],
        }),
      );
      const out = path.join(dir, 'answers.json');
      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, 'oracle.ts'),
          'keys',
          '--repo',
          FIXTURE,
          '--tsconfig',
          'tsconfig.json',
          '--questions',
          questions,
          '--out',
          out,
        ],
        { encoding: 'utf8', env: process.env },
      );
      assert.equal(result.status, 0, result.stderr);
      const parsed = AnswerFileSchema.parse(JSON.parse(fs.readFileSync(out, 'utf8')));
      assert.deepEqual(
        parsed.answers.map((answer) => answer.questionId),
        ['q-1', 'q-2'],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
