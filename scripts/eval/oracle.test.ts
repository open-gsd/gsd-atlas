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

  test('computed require paths: path.join and path.resolve over __dirname, constants and templates are followed', async () => {
    const text = [
      "'use strict';",
      "const path = require('node:path');",
      "const libDir = path.join(__dirname, '..', 'out');",
      "const { compute } = require(path.join(libDir, 'lib.cjs'));", // 4: via a const
      "const viaJoin = require(path.join(__dirname, '..', 'out', 'lib.cjs'));", // 5: direct
      'const viaTemplate = require(`${libDir}/lib.cjs`);', // 6: template
      "const viaResolve = require(path.resolve(__dirname, '../src/lib.cjs'));", // 7: sibling specifier of the source
      "const unknown = require(path.join(process.cwd(), 'out', 'lib.cjs'));", // 8: runtime value, not followed
      "const other = require(path.join(libDir, 'other.cjs'));", // 9: another file
      'function pick(dir) {',
      "  return require(path.join(dir, 'lib.cjs'));", // 11: parameter, not followed
      '}',
      'compute(1);',
      'module.exports = { compute, viaJoin, viaTemplate, viaResolve, unknown, other, pick };',
      '',
    ].join('\n');
    const repo = tempRepo(undefined, { 'tools/dyn.cjs': text });
    try {
      const answer = await computeAnswerKey({ kind: 'emit-consumers', source: 'src/lib.cts', ...REF }, repo.ctx);
      assert.deepEqual(answer.items, [
        { file: 'consumer.cjs', line: 3 },
        { file: 'src/user.cts', line: 11 },
        { file: 'tools/dyn.cjs', line: 4 },
        { file: 'tools/dyn.cjs', line: 5 },
        { file: 'tools/dyn.cjs', line: 6 },
        { file: 'tools/dyn.cjs', line: 7 },
      ]);
      const callers = await computeAnswerKey(callersOfCompute(), repo.ctx);
      assert.ok(
        callers.items.some((item) => item.file === 'tools/dyn.cjs'),
        'a use of a symbol bound from a computed require is a caller',
      );
    } finally {
      repo.cleanup();
    }
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

const ORACLE_CLI = path.join(import.meta.dirname, 'oracle.ts');

function cli(args: string[]) {
  return spawnSync(process.execPath, [ORACLE_CLI, ...args], { encoding: 'utf8', env: cleanGitEnv() });
}

function headOf(dir: string): string {
  return run(dir, 'git', ['rev-parse', 'HEAD']).trim();
}

function writeQuestions(file: string, sha: string): void {
  fs.writeFileSync(
    file,
    JSON.stringify({
      corpusId: 'fixture',
      corpusSha: sha,
      questions: [
        { id: 'q-1', category: 'callers', text: 'Who calls compute?', key: callersOfCompute() },
        { id: 'q-2', category: 'adr', text: 'Which files cite ADR 2?', key: { kind: 'adr-citers', number: 2, ...REF } },
        { id: 'q-3', category: 'emit', text: 'Who requires the emitted lib?', key: { kind: 'emit-consumers', source: 'src/lib.cts', ...REF } },
        { id: 'q-4', category: 'abstain', text: 'Where is the missing thing?', key: { kind: 'abstain', probe: { symbol: 'doesNotExistAnywhere' }, ...FILE } },
      ],
    }),
  );
}

describe('independence', () => {
  test('independence: the oracle and the question shapes import only the compiler, zod and Node built-ins', () => {
    const allowed = (specifier: string): boolean =>
      specifier.startsWith('node:') || specifier === 'typescript' || specifier === 'zod' || specifier === './questions.ts';
    for (const name of ['oracle.ts', 'questions.ts']) {
      const text = fs.readFileSync(path.join(import.meta.dirname, name), 'utf8');
      const specifiers = [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map(
        (match) => match[1],
      );
      assert.ok(specifiers.length > 0, `${name}: no import found, the check would be vacuous`);
      for (const specifier of specifiers) {
        assert.ok(allowed(specifier), `${name} imports ${specifier}`);
        assert.ok(!specifier.includes('src/'), `${name} imports from src/: ${specifier}`);
        assert.ok(!specifier.includes('web-tree-sitter'), `${name} imports web-tree-sitter`);
        assert.ok(!specifier.endsWith('/index.ts'), `${name} imports an index module: ${specifier}`);
      }
      for (const forbidden of ['.gsd-atlas', 'facts.db', 'gsd-atlas-mcp']) {
        assert.ok(!text.includes(forbidden), `${name} names ${forbidden}`);
      }
    }
  });
});

describe('encoding', () => {
  test('CRLF and BOM: the same lines as the LF fixture for callers, ADR citers and emit consumers', async () => {
    const lf = fixtureCtx();
    const repo = tempRepo((_rel, text) => `﻿${text.replace(/\n/g, '\r\n')}`);
    try {
      const specs: KeySpec[] = [
        callersOfCompute(),
        { kind: 'adr-citers', number: 1, ...REF },
        { kind: 'adr-citers', number: 2, ...REF },
        { kind: 'adr-citers', number: 3, ...REF },
        { kind: 'emit-consumers', source: 'src/lib.cts', ...REF },
        { kind: 'references', symbol: 'compute', definedIn: 'src/lib.cts', ...REF },
      ];
      for (const spec of specs) {
        const expected = await computeAnswerKey(spec, lf);
        const actual = await computeAnswerKey(spec, repo.ctx);
        assert.deepEqual(actual.items, expected.items, `${spec.kind}`);
        assert.deepEqual(actual.unexplained, []);
      }
    } finally {
      repo.cleanup();
    }
  });

  test('U+2028 is not a line break: the line of a call is the editor line', async () => {
    const baseline = await computeAnswerKey(callersOfCompute(), fixtureCtx());
    const repo = tempRepo((rel, text) =>
      rel === 'src/user.cts' ? text.replace('// The require below', `export const sep = \`a b\`;\n// The require below`) : text,
    );
    try {
      const shifted = await computeAnswerKey(callersOfCompute(), repo.ctx);
      assert.deepEqual(
        shifted.items.map((item) => `${item.file}:${item.line}`),
        baseline.items.map((item) => `${item.file}:${(item.line as number) + (item.file === 'src/user.cts' ? 1 : 0)}`),
      );
    } finally {
      repo.cleanup();
    }
  });

  test('U+2028 inside a string literal before a call does not move the call', async () => {
    const baseline = await computeAnswerKey(callersOfCompute(), fixtureCtx());
    const repo = tempRepo((rel, text) =>
      rel === 'src/user.cts' ? text.replace('// The require below', `export const sep = "a b";\n// The require below`) : text,
    );
    try {
      const shifted = await computeAnswerKey(callersOfCompute(), repo.ctx);
      const userLines = (answer: typeof baseline) =>
        answer.items.filter((item) => item.file === 'src/user.cts').map((item) => item.line as number);
      assert.deepEqual(
        userLines(shifted),
        userLines(baseline).map((line) => line + 1),
      );
    } finally {
      repo.cleanup();
    }
  });

  test('comment detection: // inside a string, a regular expression or a template is not a comment', async () => {
    const repo = tempRepo(undefined, {
      'src/tricky.cts':
        "export const url = 'http://example.invalid/ADR-7'; // ADR-8 trailing\n" +
        'export const pattern = /\\/\\/ ADR-6/;\n' +
        'export const tpl = `// ADR-5 ${1}`;\n' +
        '/* ADR-4\n   spans lines, ADR-4 §2 */\n',
    });
    try {
      const cites = async (number: number) =>
        (await computeAnswerKey({ kind: 'adr-citers', number, ...REF }, repo.ctx));
      assert.deepEqual((await cites(8)).items, [{ file: 'src/tricky.cts', line: 1 }]);
      assert.deepEqual((await cites(7)).items, []);
      assert.equal((await cites(7)).notes.excludedNonComment, 1);
      assert.deepEqual((await cites(6)).items, []);
      assert.deepEqual((await cites(5)).items, []);
      assert.equal((await cites(5)).notes.excludedNonComment, 1);
      assert.deepEqual((await cites(4)).items, [
        { file: 'src/tricky.cts', line: 4 },
        { file: 'src/tricky.cts', line: 5, detail: '§2' },
      ]);
    } finally {
      repo.cleanup();
    }
  });
});

describe('command line', () => {
  test('check mode: exits 0 on unchanged input, 1 with the question id after a fixture line changes', () => {
    const repo = tempRepo();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-check-'));
    try {
      const questions = path.join(scratch, 'questions.json');
      const answers = path.join(scratch, 'answers.json');
      writeQuestions(questions, headOf(repo.dir));
      const base = ['--repo', repo.dir, '--tsconfig', 'tsconfig.json', '--questions', questions];
      assert.equal(cli(['keys', ...base, '--out', answers]).status, 0);
      assert.equal(cli(['check', ...base, '--answers', answers]).status, 0);

      const user = path.join(repo.dir, 'src', 'user.cts');
      fs.writeFileSync(user, `// one more line at the top\n${fs.readFileSync(user, 'utf8')}`);
      const changed = cli(['check', ...base, '--answers', answers]);
      assert.equal(changed.status, 1);
      assert.match(changed.stderr, /q-1: item (removed|added)/);
      assert.match(changed.stderr, /q-2: item (removed|added)/);
      assert.ok(!/q-4/.test(changed.stderr), 'an unchanged question is not reported');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
      repo.cleanup();
    }
  });

  test('check mode without arguments prints a usage message and exits 2', () => {
    const result = cli(['check']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage/);
    assert.equal(cli([]).status, 2);
  });

  test('deterministic output: two runs of keys write byte-identical files without absolute paths', () => {
    const repo = tempRepo();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-det-'));
    try {
      const questions = path.join(scratch, 'questions.json');
      writeQuestions(questions, headOf(repo.dir));
      const base = ['--repo', repo.dir, '--tsconfig', 'tsconfig.json', '--questions', questions];
      const first = path.join(scratch, 'first.json');
      const second = path.join(scratch, 'second.json');
      assert.equal(cli(['keys', ...base, '--out', first]).status, 0);
      assert.equal(cli(['keys', ...base, '--out', second]).status, 0);
      const bytes = fs.readFileSync(first);
      assert.ok(bytes.equals(fs.readFileSync(second)));
      const parsed = AnswerFileSchema.parse(JSON.parse(bytes.toString('utf8')));
      assert.equal(parsed.repoSha, headOf(repo.dir));
      assert.ok(!bytes.toString('utf8').includes(repo.dir), 'no absolute path of the checkout in the output');
      assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(bytes.toString('utf8')), 'no timestamp in the output');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
      repo.cleanup();
    }
  });

  test('a directory outside a git work tree is refused with a clear error', async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-nogit-')));
    try {
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ "include": ["a.ts"] }');
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
      await assert.rejects(
        computeAnswerKey({ kind: 'definition', symbol: 'a', definedIn: 'a.ts', ...REF }, { repoDir: dir, tsconfig: 'tsconfig.json' }),
        (error: unknown) => error instanceof OracleError && error.code === 'NOT_A_GIT_WORK_TREE',
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
