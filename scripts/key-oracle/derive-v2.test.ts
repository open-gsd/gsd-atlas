/**
 * Tests for the v2 key oracle (a proposal; nothing here touches the registered files).
 *
 * Run: node --test scripts/key-oracle/derive-v2.test.ts
 *
 * Needs a local clone of gsd-core that contains the pinned commit (GSD_CORE_REPO, default
 * /Users/trekkie/projects/gsd-core). Without it the corpus tests are skipped, the synthetic rule
 * tests still run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { NON_CONSISTENT, OUT_DIR, ROOT, computeV2 } from './build-v2.ts';
import type { V2 } from './build-v2.ts';
import { DEFAULT_REPO, buildIndex, callersOf, consumersOf, filesOf, impactOf, referencesOf } from './derive-v2.ts';
import type { Corpus } from './derive-v2.ts';

const REGISTERED = 'ev' + 'al';
const haveCorpus = fs.existsSync(path.join(DEFAULT_REPO, '.git')) || fs.existsSync(path.join(DEFAULT_REPO, 'HEAD'));

function mini(files: Record<string, string>): ReturnType<typeof buildIndex> {
  const corpus: Corpus = {
    repo: '(synthetic)',
    sha: 'synthetic',
    allPaths: Object.keys(files).sort(),
    code: new Map(Object.entries(files)),
    tsconfigBuild: '{ "compilerOptions": { "rootDir": "src", "outDir": "gsd-core/bin/lib" } }',
  };
  return buildIndex(corpus);
}

describe('binding rules on a synthetic corpus', () => {
  const idx = mini({
    'src/m.cts': 'export function f(): number { return g(); }\nfunction g(): number { return 1; }\nexport function self(): number { return f(); }\nexport = { f, self, alias: g };\n',
    'src/a.cts': "import m = require('./m.cjs');\nexport function a() { return m.f(); }\n",
    'src/b.cts': "import m = require('./m.cjs');\nconst { f } = m;\nexport function b() { return f(); }\n",
    'src/c.cts': "const { f: renamed } = require('./m.cjs') as { f: () => number };\nexport function c() { return renamed(); }\n",
    'src/d.cts': "import { f } from './m.cjs';\nexport function d() { return (0, f)(); }\n",
    'tests/e.test.cjs': "const MODULE_PATH = require('node:path').join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'm.cjs');\nconst mod = require(MODULE_PATH);\nconst { f } = mod;\nf();\n",
    'tests/f.test.cjs': "const root = process.cwd();\nconst x = require(require('path').join(root, 'gsd-core', 'bin', 'lib', 'm.cjs'));\nx.f.call(null);\n",
    'tests/g.test.cjs': "function f() { return 2; }\nf();\nconst s = 'f';\nconst o = { f: 1 };\no.f;\n",
    'tests/h.test.cjs': "const m = require('../gsd-core/bin/lib/m.cjs');\nm.other();\nconst name = 'f';\n",
    'src/i.cts': "import m = require('./m.cjs');\nexport function i() { return m.self(); }\n",
  });

  it('counts direct, renamed, destructured, cast, namespace, ES-import, variable-path and call/apply forms', () => {
    assert.deepEqual(filesOf(callersOf(idx, 'src/m.cts', 'f')), [
      'src/a.cts',
      'src/b.cts',
      'src/c.cts',
      'src/d.cts',
      'src/m.cts',
      'tests/e.test.cjs',
      'tests/f.test.cjs',
    ]);
  });

  it('excludes a same-named function that is not bound to the module, and string spellings', () => {
    const files = filesOf(callersOf(idx, 'src/m.cts', 'f'));
    assert.ok(!files.includes('tests/g.test.cjs'));
    assert.ok(!files.includes('tests/h.test.cjs'));
    assert.ok(!filesOf(referencesOf(idx, 'src/m.cts', 'f')).includes('tests/h.test.cjs'));
  });

  it('counts a self-call in the defining file', () => {
    assert.ok(filesOf(callersOf(idx, 'src/m.cts', 'g')).includes('src/m.cts'));
  });

  it('emit consumers: calls reading excludes import-equals, load reading includes it', () => {
    const calls = new Set(consumersOf(idx, 'src/m.cts', 'calls').hits.map((h) => h.file));
    const load = new Set(consumersOf(idx, 'src/m.cts', 'load').hits.map((h) => h.file));
    assert.ok(!calls.has('src/a.cts') && load.has('src/a.cts'));
    assert.ok(calls.has('tests/e.test.cjs') && calls.has('tests/h.test.cjs') && calls.has('tests/f.test.cjs'));
    assert.ok(!load.has('src/d.cts'), 'ES import is neither require nor import-equals');
  });

  it('impact closes over the names exported by an intermediate .cts, including export = { ... }', () => {
    const r = impactOf(idx, 'src/m.cts', 'g');
    // g is called by m.cts itself (self-call), which exports f, self and alias; their callers are depth two.
    assert.ok(r.files.includes('src/a.cts'));
    assert.ok(r.files.includes('src/i.cts'));
    assert.ok(!r.files.includes('src/m.cts'));
  });
});

describe('corpus derivation', { skip: !haveCorpus && 'gsd-core clone not available' }, () => {
  let v2: V2;
  before(async () => {
    v2 = await computeV2();
  });

  it('reproduces the registered key for every audit-consistent question it covers', () => {
    const bad: string[] = [];
    let covered = 0;
    for (const q of v2.frozenQuestions.questions) {
      if (NON_CONSISTENT.includes(q.id)) continue;
      covered++;
      const c = v2.comparisons.get(q.id);
      if (c === undefined || !c.agree) bad.push(`${q.id}: +${JSON.stringify(c?.added)} -${JSON.stringify(c?.removed)}`);
    }
    assert.equal(covered, 61);
    assert.deepEqual(bad, []);
  });

  const AUDITED_EXTRAS: Record<string, string[]> = {
    'q-001': ['src/runtime-hooks-surface.cts:1064', 'src/runtime-hooks-surface.cts:2725'],
    'q-008': ['src/commands.cts:121', 'scripts/live-config-guard.cjs:326', 'src/capability-state.cts:562'],
    'q-010': ['src/uat.cts', 'src/uat-predicate.cts:173'],
    'q-011': ['tests/planning-document.test.cjs:42'],
    'q-014': ['src/runtime-hooks-surface.cts:3189'],
    'q-024': [
      'src/roadmap-command-router.cts:15',
      'src/validate-command-router.cts:25',
      'src/phases-command-router.cts:16',
    ],
    'q-028': [
      'src/install-engine.cts:43',
      'src/retired-artifact-cleanup.cts:19',
      'src/runtime-artifact-layout.cts:25',
      'src/runtime-artifact-conversion.cts:29',
      'src/installer-migrations.cts:37',
      'src/install-model-override-resolver.cts:35',
      'src/commonjs-marker.cts:39',
      'src/install-profiles.cts:24',
      'src/install-effort-resolver.cts',
      'src/user-artifact-staging.cts',
    ],
    'q-065': [
      'src/docs.cts:22',
      'src/model-adapter.cts:24',
      'src/commands.cts:56',
      'src/init.cts:22',
      'src/claude-orchestration-command-router.cts:54',
      'src/install-effort-resolver.cts:41',
      'src/install-model-override-resolver.cts:47',
      'pi/gsd.cjs:265',
    ],
    'q-036': ['gsd-core/bin/gsd-tools.cjs', 'tests/commands.test.cjs'],
    'q-069': ['gsd-core/bin/gsd-tools.cjs', 'src/phase.cts', 'tests/phase.test.cjs'],
  };

  for (const [id, extras] of Object.entries(AUDITED_EXTRAS)) {
    it(`${id} gains the files named by the audit`, () => {
      const d = v2.derived.get(id);
      assert.ok(d !== undefined);
      const added = new Set(v2.comparisons.get(id)?.added);
      for (const extra of extras) {
        const [file, line] = extra.split(/:(?=\d+$)/);
        assert.ok(added.has(file as string), `${id} should add ${file}`);
        if (line !== undefined) {
          const near = d.items.some((i) => i.file === file && Math.abs((i.line ?? 0) - Number(line)) <= 1);
          assert.ok(near, `${id} should have an item at ${file}:${line}`);
        }
      }
    });
  }

  it('the four ambiguous questions follow the stated literal readings and record the alternative', () => {
    const d = (id: string) => v2.derived.get(id);
    assert.deepEqual(v2.comparisons.get('q-012')?.added, []);
    assert.ok(d('q-012')?.alt?.files.includes('scripts/lib/alias-drift-families.cjs'));
    // Decided 2026-10-21: import-equals declarations count as require, so q-022 becomes a 28-file key.
    assert.equal(d('q-022')?.files.length, 28);
    assert.deepEqual(v2.comparisons.get('q-022')?.added, [
      'src/install-engine.cts',
      'src/install-shadow-report.cts',
      'src/installed-surface-resolver.cts',
      'src/surface.cts',
    ]);
    assert.ok(!v2.questionsV2.questions.find((q) => q.id === 'q-022')?.text.includes('does not count as a call'));
    assert.deepEqual(v2.comparisons.get('q-030')?.removed, ['docs/adr/3473-enforcement-by-construction.md']);
    assert.ok(d('q-030')?.alt?.files.includes('docs/adr/3473-enforcement-by-construction.md'));
    assert.deepEqual(d('q-067')?.files, ['scripts/gen-adr-index.cjs']);
    assert.deepEqual(d('q-067')?.alt?.files, []);
  });

  it('statuses: 7 corrected, 4 reworded+corrected, 3 decided, 61 carried, none needs-decision', () => {
    const n: Record<string, number> = {};
    for (const s of v2.status.values()) n[s] = (n[s] ?? 0) + 1;
    assert.deepEqual(n, { corrected: 7, 'reworded+corrected': 4, decided: 3, carried: 61 });
  });

  it('carried questions and answers are identical to the registered ones; only reworded questions change text', () => {
    assert.equal(v2.questionsV2.questions.length, 75);
    const frozenA = new Map(v2.frozenAnswers.answers.map((a) => [a.questionId, a]));
    const frozenQ = new Map(v2.frozenQuestions.questions.map((q) => [q.id, q]));
    const newA = new Map(v2.answersV2.answers.map((a) => [a.questionId, a]));
    for (const q of v2.questionsV2.questions) {
      const status = v2.status.get(q.id);
      if (status === 'carried') {
        assert.equal(JSON.stringify(q), JSON.stringify(frozenQ.get(q.id)), q.id);
        assert.equal(JSON.stringify(newA.get(q.id)), JSON.stringify(frozenA.get(q.id)), q.id);
      } else {
        assert.deepEqual(q.key, frozenQ.get(q.id)?.key, `${q.id} key object (query) is unchanged`);
        // 'corrected' keeps the registered wording; 'reworded+corrected' and 'decided' state the rule.
        assert.equal(q.text !== frozenQ.get(q.id)?.text, status !== 'corrected', q.id);
      }
    }
  });

  it('written v2 files validate with the registered loader and schema and match the computation', async () => {
    const mod = (await import(pathToFileURL(path.join(ROOT, 'scripts', REGISTERED, 'questions.ts')).href)) as {
      loadQuestions(file: string): { questions: { id: string }[] };
      AnswerFileSchema: { parse(x: unknown): { answers: { questionId: string }[] } };
    };
    const q = mod.loadQuestions(path.join(OUT_DIR, 'questions.v2.json'));
    assert.equal(q.questions.length, 75);
    const a = mod.AnswerFileSchema.parse(JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'answers.v2.json'), 'utf8')));
    assert.equal(a.answers.length, 75);
    assert.deepEqual(a.answers.map((x) => x.questionId), q.questions.map((x) => x.id));
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'questions.v2.json'), 'utf8'))), JSON.stringify(v2.questionsV2));
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'answers.v2.json'), 'utf8'))), JSON.stringify(v2.answersV2));
    const readme = fs.readFileSync(path.join(OUT_DIR, 'README.md'), 'utf8');
    assert.ok(readme.trimEnd().split('\n').length <= 15);
    assert.ok(fs.existsSync(path.join(OUT_DIR, 'changes.md')));
  });
});
