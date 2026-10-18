import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import { SCHEMA_VERSION } from '../src/fact-store/schema.ts';
import {
  STRATA,
  createVerifyEnv,
  drawSample,
  findStoreFile,
  loadPopulation,
  passesGate,
  renderTable,
  runCli,
  runEdgeSample,
  verifyCitation,
  verifyDefinition,
  verifyExport,
  verifyFact,
  verifyImport,
  verifyReferenceEdge,
  verifyRelation,
} from './edge-sample.ts';
import type {
  CitationFact,
  DefinitionFact,
  ExportFact,
  Fact,
  ImportFact,
  LoadedPopulation,
  ReferenceEdgeFact,
  RelationFact,
  SampleReport,
  Strata,
  Stratum,
  VerifyEnv,
} from './edge-sample.ts';
import { buildAndReadRelations } from './relations-check.ts';

/** The oracle's own fixture repository, plus a copy with an override, an implements and an ADR comment. */
const FIXTURE = path.join(import.meta.dirname, 'eval', '__fixtures__', 'oracle-repo');

const EXTRA = [
  'export class Animal {',
  '  speak(): string {',
  "    return 'a';",
  '  }',
  '}',
  'export class Dog extends Animal {',
  '  override speak(): string {',
  "    return 'woof';",
  '  }',
  '}',
  'export interface Runner {',
  '  run(): void;',
  '}',
  'export class Impl implements Runner {',
  '  run(): void {}',
  '}',
  '// Speaking is described in ADR 4 section two.',
  'export const talk = (animal: Animal): string => animal.speak();',
  '',
].join('\n');

const TARGETS = [
  { definedIn: 'src/lib.cts', symbol: 'Base', kind: 'class' as const },
  { definedIn: 'src/lib.cts', symbol: 'Shape', kind: 'interface' as const },
  { definedIn: 'src/extra.cts', symbol: 'Animal', kind: 'class' as const },
  { definedIn: 'src/extra.cts', symbol: 'Runner', kind: 'interface' as const },
];

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return env;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
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

function tempRepo(extra: Readonly<Record<string, string>>): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-sample-test-')));
  for (const rel of listFiles(FIXTURE)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE, ...rel.split('/')), target);
  }
  for (const [rel, text] of Object.entries(extra)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=check', '-c', 'user.email=check@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
  return dir;
}

function removeTree(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function ofStratum<T extends Fact>(population: LoadedPopulation, stratum: Stratum): T[] {
  return population.strata[stratum] as T[];
}

function emptyStrata(): Record<Stratum, Fact[]> {
  return { definition: [], import: [], export: [], reference_edge: [], relation: [], citation: [] };
}

const SPAN = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 1 };

function syntheticDefinitions(count: number, tag = 'd'): DefinitionFact[] {
  return Array.from({ length: count }, (_, index) => ({
    stratum: 'definition' as const,
    key: `definition|${tag}${String(index).padStart(4, '0')}`,
    path: `${tag}${String(index)}.ts`,
    hash: null,
    span: SPAN,
    name: `n${String(index)}`,
    qualifiedName: `n${String(index)}`,
    kind: 'function',
  }));
}

describe('edge-sample against the oracle fixture with an override and an implements', () => {
  let dir = '';
  let work = '';
  let dbFile = '';
  let population: LoadedPopulation;
  let env: VerifyEnv;

  before(async () => {
    dir = tempRepo({ 'src/extra.cts': EXTRA });
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-sample-work-'));
    await buildAndReadRelations(dir, work, TARGETS);
    dbFile = findStoreFile(path.join(work, 'stores'));
    population = loadPopulation(dbFile, { worktree: dir });
    env = createVerifyEnv({ repoDir: dir, overlayPaths: population.overlayPaths });
  });

  after(() => {
    removeTree(dir);
    removeTree(work);
  });

  it('population has every stratum', () => {
    for (const stratum of STRATA) {
      assert.ok(population.strata[stratum].length > 0, `no facts in the ${stratum} stratum`);
    }
    assert.equal(population.schemaVersion, SCHEMA_VERSION, 'the script was written for another schema version');
    const relations = ofStratum<RelationFact>(population, 'relation').map((fact) => fact.relation);
    for (const kind of ['extends', 'implements', 'overrides']) assert.ok(relations.includes(kind), `no ${kind} relation`);
    const keys = STRATA.flatMap((stratum) => population.strata[stratum].map((fact) => fact.key));
    assert.equal(new Set(keys).size, keys.length, 'a fact key repeats');
    assert.ok(population.overlayPaths.has('src/extra.cts'));
  });

  it('seeded stratified draw', () => {
    const first = drawSample(population.strata, 12, 7);
    assert.equal(first.length, 12);
    for (const stratum of STRATA) {
      assert.ok(first.filter((fact) => fact.stratum === stratum).length >= 2, `fewer than two ${stratum} facts`);
    }
    assert.deepEqual(
      drawSample(population.strata, 12, 7).map((fact) => fact.key),
      first.map((fact) => fact.key),
      'the same seed must draw the same list',
    );
    assert.notDeepEqual(
      drawSample(population.strata, 12, 8).map((fact) => fact.key),
      first.map((fact) => fact.key),
      'another seed must draw another list',
    );
    assert.equal(new Set(first.map((fact) => fact.key)).size, first.length, 'a fact was drawn twice');
    const everything = drawSample(population.strata, 100_000, 7);
    assert.equal(everything.length, STRATA.reduce((sum, stratum) => sum + population.strata[stratum].length, 0));
  });

  it('seeded stratified draw: an empty stratum counts for nothing and the sample is topped up from the largest strata', () => {
    const strata = emptyStrata();
    strata.definition = syntheticDefinitions(60, 'a');
    strata.export = [];
    const draw = drawSample(strata as unknown as Strata, 20, 3);
    assert.equal(draw.length, 20);
    assert.ok(draw.every((fact) => fact.stratum === 'definition'));
    const mixed = emptyStrata();
    mixed.definition = syntheticDefinitions(100, 'a');
    mixed.citation = syntheticDefinitions(3, 'c').map((fact) => ({ ...fact, stratum: 'citation' as const, number: 1, detail: null })) as unknown as CitationFact[];
    const second = drawSample(mixed as unknown as Strata, 30, 3);
    assert.equal(second.length, 30);
    assert.equal(second.filter((fact) => fact.stratum === 'citation').length, 3, 'a stratum smaller than its share gives all it has');
  });

  it('definition verifier', () => {
    const definitions = ofStratum<DefinitionFact>(population, 'definition');
    for (const fact of definitions) {
      const verdict = verifyDefinition(fact, env);
      assert.equal(verdict.verdict, 'correct', `${fact.path} ${fact.qualifiedName} ${fact.kind}: ${verdict.reason}`);
    }
    const compute = definitions.find((fact) => fact.path === 'src/lib.cts' && fact.name === 'compute');
    assert.ok(compute);
    assert.equal(verifyDefinition({ ...compute, kind: 'class' }, env).verdict, 'wrong', 'a wrong kind');
    assert.equal(verifyDefinition({ ...compute, name: 'computed' }, env).verdict, 'wrong', 'a wrong name');
    assert.equal(
      verifyDefinition({ ...compute, span: { ...compute.span, startLine: compute.span.startLine + 4, endLine: compute.span.endLine + 4 } }, env).verdict,
      'wrong',
      'a moved span',
    );
    const member = definitions.find((fact) => fact.qualifiedName === 'Animal.speak');
    assert.ok(member);
    assert.equal(verifyDefinition({ ...member, qualifiedName: 'Dog.speak' }, env).verdict, 'wrong', 'a wrong container');
  });

  it('import verifier', () => {
    const imports = ofStratum<ImportFact>(population, 'import');
    assert.ok(imports.some((fact) => fact.style === 'cjs') && imports.some((fact) => fact.style === 'es'));
    for (const fact of imports) {
      const verdict = verifyImport(fact, env);
      assert.equal(verdict.verdict, 'correct', `${fact.path} ${fact.specifier}: ${verdict.reason}`);
    }
    const es = imports.find((fact) => fact.path === 'src/shapes.cts' && fact.specifier === './lib.cjs');
    assert.ok(es);
    assert.equal(verifyImport({ ...es, specifier: './elsewhere.cjs' }, env).verdict, 'wrong', 'a specifier the statement does not hold');
    const cjs = imports.find((fact) => fact.style === 'cjs' && fact.path === 'src/user.cts');
    assert.ok(cjs);
    assert.equal(verifyImport({ ...cjs, span: { startLine: 11, startColumn: 2, endLine: 11, endColumn: 16 } }, env).verdict, 'wrong', 'a span that is not an import');
  });

  it('export verifier', () => {
    const exports = ofStratum<ExportFact>(population, 'export');
    for (const fact of exports) {
      const verdict = verifyExport(fact, env);
      assert.equal(verdict.verdict, 'correct', `${fact.path} ${fact.name}: ${verdict.reason}`);
    }
    const compute = exports.find((fact) => fact.path === 'src/lib.cts' && fact.name === 'compute');
    assert.ok(compute);
    assert.equal(verifyExport({ ...compute, name: 'notExported' }, env).verdict, 'wrong', 'a name the statement does not export');
    const run = exports.find((fact) => fact.path === 'consumer.cjs');
    assert.ok(run, 'the CommonJS export of the fixture');
    assert.equal(verifyExport({ ...run, name: 'other' }, env).verdict, 'wrong', 'a CommonJS name that is not exported');
  });

  it('reference edge verifier', () => {
    const edges = ofStratum<ReferenceEdgeFact>(population, 'reference_edge');
    assert.ok(edges.length >= 5);
    for (const fact of edges) {
      const verdict = verifyReferenceEdge(fact, env);
      assert.equal(verdict.verdict, 'correct', `${fact.path} ${fact.name} -> ${fact.targetPath} ${fact.targetQualifiedName}: ${verdict.reason}`);
    }
    const helper = edges.find((fact) => fact.name === 'helper');
    assert.ok(helper);
    assert.equal(verifyReferenceEdge({ ...helper, targetPath: 'src/shapes.cts' }, env).verdict, 'wrong', 'a target in another file');
    assert.equal(verifyReferenceEdge({ ...helper, targetQualifiedName: 'compute' }, env).verdict, 'wrong', 'a target of another name');
    assert.ok(edges.some((fact) => fact.name === 'speak'), 'the member call is an edge');
  });

  it('relation verifier', () => {
    const relations = ofStratum<RelationFact>(population, 'relation');
    for (const fact of relations) {
      const verdict = verifyRelation(fact, env);
      assert.equal(verdict.verdict, 'correct', `${fact.relation} ${fact.fromQualifiedName} -> ${fact.toQualifiedName}: ${verdict.reason}`);
    }
    const dog = relations.find((fact) => fact.relation === 'extends' && fact.fromQualifiedName === 'Dog');
    assert.ok(dog);
    assert.equal(verifyRelation({ ...dog, toQualifiedName: 'Base', toPath: 'src/lib.cts' }, env).verdict, 'wrong', 'a base the class does not extend');
    assert.equal(verifyRelation({ ...dog, relation: 'implements' }, env).verdict, 'wrong', 'extends claimed as implements');
    const override = relations.find((fact) => fact.relation === 'overrides');
    assert.ok(override);
    assert.equal(verifyRelation({ ...override, toQualifiedName: 'Animal.other' }, env).verdict, 'wrong', 'an override of a member the base lacks');
    const impl = relations.find((fact) => fact.relation === 'implements');
    assert.ok(impl);
    assert.equal(verifyRelation({ ...impl, toQualifiedName: 'Shape', toPath: 'src/lib.cts' }, env).verdict, 'wrong', 'an interface the class does not implement');
  });

  it('citation verifier', () => {
    const citations = ofStratum<CitationFact>(population, 'citation');
    assert.ok(citations.length >= 4);
    for (const fact of citations) {
      const verdict = verifyCitation(fact, env);
      assert.equal(verdict.verdict, 'correct', `${fact.path} ADR ${String(fact.number)}: ${verdict.reason}`);
    }
    const one = citations.find((fact) => fact.number === 1);
    assert.ok(one);
    assert.equal(verifyCitation({ ...one, number: 9 }, env).verdict, 'wrong', 'a number the comment does not hold');
    assert.ok(citations.some((fact) => fact.path === 'src/extra.cts' && fact.number === 4), 'the comment of the copy');
    // The string literal of src/user.cts mentions ADR-9 outside any comment; a citation at that span is wrong.
    const inString = { ...one, path: 'src/user.cts', hash: population.strata.citation.find((fact) => fact.path === 'src/user.cts')?.hash ?? null, number: 9, span: { startLine: 21, startColumn: 52, endLine: 21, endColumn: 57 } };
    assert.equal(verifyCitation(inString, env).verdict, 'wrong', 'a mention inside a string literal');
  });

  it('corrupted store is detected', async () => {
    const corrupt = path.join(work, 'corrupt.db');
    fs.copyFileSync(dbFile, corrupt);
    const db = new DatabaseSync(corrupt);
    try {
      const changed = db.prepare("UPDATE resolved_edges SET target_path = 'src/shapes.cts' WHERE name = 'helper'").run();
      assert.equal(Number(changed.changes), 1);
    } finally {
      db.close();
    }
    const clean = await runEdgeSample({ dir, seed: 7, n: 100_000, storeFile: dbFile, tsconfig: 'tsconfig.json' });
    assert.equal(clean.report.wrong + clean.report.unverifiable, 0, 'the clean store has a wrong fact');
    assert.equal(clean.exitCode, 0);
    const result = await runEdgeSample({ dir, seed: 7, n: 100_000, storeFile: corrupt, tsconfig: 'tsconfig.json' });
    const bad = result.report.rows.filter((row) => row.verdict.verdict !== 'correct');
    assert.equal(bad.length, 1, bad.map((row) => row.verdict.reason).join('; '));
    assert.equal(bad[0]?.fact.stratum, 'reference_edge');
    assert.ok(result.report.precision < 1);
  });

  it('an unverifiable fact counts as wrong and is listed', async () => {
    const copy = tempRepo({ 'src/extra.cts': EXTRA });
    try {
      // The same index, but the checkout has lost one of its files.
      const lostEnv = createVerifyEnv({ repoDir: copy, overlayPaths: population.overlayPaths });
      fs.rmSync(path.join(copy, 'src', 'user.cts'));
      const fact = ofStratum<DefinitionFact>(population, 'definition').find((candidate) => candidate.path === 'src/user.cts');
      assert.ok(fact);
      assert.equal(verifyDefinition(fact, lostEnv).verdict, 'unverifiable');
      assert.equal(verifyFact(fact, lostEnv).verdict, 'unverifiable');
      const result = await runEdgeSample({ dir: copy, worktree: dir, seed: 7, n: 100_000, storeFile: dbFile, tsconfig: 'tsconfig.json' });
      assert.ok(result.report.unverifiable > 0);
      assert.ok(result.report.precision < 1);
      const text = renderTable(result.report);
      assert.match(text, /## Wrong or unverifiable/);
      assert.match(text, /src\/user\.cts/);
    } finally {
      removeTree(copy);
    }
  });

  it('exit codes', async () => {
    assert.equal(passesGate(99, 100), true);
    assert.equal(passesGate(98, 100), true, '0.98 is at the gate');
    assert.equal(passesGate(97, 100), false);
    assert.equal(passesGate(0, 0), false);

    const synthetic = (): LoadedPopulation => {
      const strata = emptyStrata();
      strata.definition = syntheticDefinitions(100);
      return { strata: strata as unknown as Strata, schemaVersion: SCHEMA_VERSION, worktree: dir, overlayPaths: new Set() };
    };
    const verifier = (wrong: number) => (fact: Fact): { verdict: 'correct' | 'wrong'; reason: string } =>
      Number(fact.path.replace(/\D/g, '')) < wrong ? { verdict: 'wrong', reason: 'planned' } : { verdict: 'correct', reason: 'planned' };
    const one = await runEdgeSample({ dir, seed: 7, n: 100, population: synthetic(), verify: verifier(1) });
    assert.equal(one.report.correct, 99);
    assert.equal(one.report.precision, 0.99);
    assert.equal(one.exitCode, 0);
    const three = await runEdgeSample({ dir, seed: 7, n: 100, population: synthetic(), verify: verifier(3) });
    assert.equal(three.report.precision, 0.97);
    assert.equal(three.exitCode, 1);

    const lines: string[] = [];
    const say = (text: string): void => void lines.push(text);
    assert.equal(await runCli([], say), 2, 'no arguments');
    assert.equal(await runCli(['--dir', dir], say), 2, 'no seed');
    assert.equal(await runCli(['--dir', dir, '--seed', 'abc'], say), 2, 'a seed that is not a number');
    assert.equal(await runCli(['--dir', dir, '--seed', '7', '--n', '0'], say), 2, 'a sample size of zero');
    assert.equal(await runCli(['--dir', dir, '--seed', '7', '--bogus'], say), 2, 'an unknown option');
    assert.match(lines.join(''), /usage:/);
    assert.equal(await runCli(['--dir', dir, '--seed', '7', '--prepared'], say, { storeFile: dbFile }), 2, 'a checkout that is not prepared');
    assert.match(lines.join(''), /prepared/);
    const viaCli = await runCli(['--dir', dir, '--seed', '7', '--n', '100'], say, { storeFile: dbFile });
    assert.equal(viaCli, 0, lines.join(''));
  });

  it('store is opened read-only', async () => {
    const before = fs.statSync(dbFile);
    const bytes = fs.readFileSync(dbFile);
    await runEdgeSample({ dir, seed: 7, n: 100, storeFile: dbFile, tsconfig: 'tsconfig.json' });
    loadPopulation(dbFile, { worktree: dir });
    const after = fs.statSync(dbFile);
    assert.equal(after.mtimeMs, before.mtimeMs, 'the store file was modified');
    assert.equal(after.size, before.size);
    assert.ok(Buffer.compare(bytes, fs.readFileSync(dbFile)) === 0, 'the store bytes changed');
    assert.throws(() => loadPopulation(dbFile, { worktree: path.join(dir, 'not-an-overlay') }), /overlay/);
  });

  it('a preparation record is read when there is one, and must agree with the checkout', async () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true }).stdout.trim();
    const recordFile = path.join(dir, '.eval-prepared.json');
    try {
      fs.writeFileSync(recordFile, JSON.stringify({ corpusId: 'fixture-corpus', sha: head, npmCi: true, typescriptVersion: '6.0.3', lockSha256: null, dir }));
      const withRecord = await runEdgeSample({ dir, seed: 7, n: 100, storeFile: dbFile, tsconfig: 'tsconfig.json' });
      assert.equal(withRecord.report.header.corpus, 'fixture-corpus');
      assert.equal(withRecord.report.header.corpusSha, head);
      assert.match(withRecord.report.header.compilers, /typescript 6\.0\.3 \(prepared/);
      fs.writeFileSync(recordFile, JSON.stringify({ corpusId: 'fixture-corpus', sha: 'f'.repeat(40), npmCi: true, typescriptVersion: '6.0.3', lockSha256: null, dir }));
      await assert.rejects(runEdgeSample({ dir, seed: 7, n: 100, storeFile: dbFile, tsconfig: 'tsconfig.json' }), /preparation record says/);
    } finally {
      fs.rmSync(recordFile, { force: true });
    }
    const without = await runEdgeSample({ dir, seed: 7, n: 100, storeFile: dbFile, tsconfig: 'tsconfig.json' });
    assert.match(without.report.header.compilers, /not prepared/);
  });

  it('the table is deterministic, keeps the hand-written part, and lists every stratum even when empty', async () => {
    const out = path.join(work, 'table.md');
    const first = await runEdgeSample({ dir, seed: 7, n: 100, storeFile: dbFile, tsconfig: 'tsconfig.json', out });
    const text = fs.readFileSync(out, 'utf8');
    assert.equal(text, renderTable(first.report) + preservedNotes(text), 'the file is the rendered table plus the notes part');
    assert.match(text, /^Overall precision /m);
    assert.match(text, /Wilson/);
    assert.match(text, /\| 5 \|/);
    for (const stratum of STRATA) assert.ok(text.includes(stratum), stratum);
    assert.match(text, /Human confirmation/);
    // Hand-written notes below the marker survive a regeneration.
    fs.writeFileSync(out, text.replace('Status: pending', 'Status: confirmed by a person'));
    await runEdgeSample({ dir, seed: 7, n: 100, storeFile: dbFile, tsconfig: 'tsconfig.json', out });
    assert.match(fs.readFileSync(out, 'utf8'), /Status: confirmed by a person/);
    const again = await runEdgeSample({ dir, seed: 7, n: 100, storeFile: dbFile, tsconfig: 'tsconfig.json' });
    assert.equal(renderTable(again.report), renderTable(first.report));
  });

  it('a stratum with no facts is listed with a count of zero', () => {
    const report: SampleReport = {
      header: { corpus: 'fixture', corpusSha: 'x', seed: 7, requested: 10, atlasCommit: 'y', compilers: 'z', schemaVersion: SCHEMA_VERSION },
      strata: STRATA.map((stratum) => ({ stratum, population: stratum === 'citation' ? 0 : 5, sampled: stratum === 'citation' ? 0 : 2, correct: stratum === 'citation' ? 0 : 2, wrong: 0, unverifiable: 0 })),
      relationKinds: [
        { relation: 'extends', population: 5, sampled: 2, correct: 2, wrong: 0, unverifiable: 0 },
        { relation: 'implements', population: 0, sampled: 0, correct: 0, wrong: 0, unverifiable: 0 },
        { relation: 'overrides', population: 0, sampled: 0, correct: 0, wrong: 0, unverifiable: 0 },
      ],
      rows: [],
      sampled: 10,
      correct: 10,
      wrong: 0,
      unverifiable: 0,
      precision: 1,
      lower: 0.72,
      upper: 1,
      passes: true,
    };
    const text = renderTable(report);
    assert.match(text, /\| citation \| 0 \| 0 \| 0 \| 0 \| 0 \|/);
    assert.match(text, /\| implements \| 0 \| 0 \| 0 \| 0 \| 0 \|/);
    assert.match(text, /\| overrides \| 0 \| 0 \| 0 \| 0 \| 0 \|/);
  });
});

/** The part of a written file from the notes marker on. */
function preservedNotes(text: string): string {
  const at = text.indexOf('<!-- edge-sample:notes -->');
  assert.ok(at >= 0, 'the notes marker is missing');
  return text.slice(at);
}

/** The blob id of a file of `dir`, from the version control tool itself. */
function blobHash(dir: string, rel: string): string {
  const result = spawnSync('git', ['hash-object', '--no-filters', rel], { cwd: dir, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** The span (0-based line, UTF-16 column) of the first occurrence of `needle` in `fileText`. */
function spanOfText(fileText: string, needle: string): { startLine: number; startColumn: number; endLine: number; endColumn: number } {
  const at = fileText.indexOf(needle);
  assert.ok(at >= 0, `${needle} is not in the text`);
  const place = (offset: number): [number, number] => {
    const before = fileText.slice(0, offset).split('\n');
    return [before.length - 1, (before[before.length - 1] as string).length];
  };
  const [startLine, startColumn] = place(at);
  const [endLine, endColumn] = place(at + needle.length);
  return { startLine, startColumn, endLine, endColumn };
}

describe('verifier regressions found by the audit of the whole pinned gsd-core population', () => {
  const files: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2023', strict: true, noEmit: true, types: [], allowJs: true },
      include: ['src'],
    }),
    'src/chain.cjs': 'exports.SaxesParser = exports.EVENTS = void 0;\n',
    'src/scopes.cjs': [
      'var Unicode = class Unicode {',
      '  static MAX = 1;',
      '  static isPrint() {}',
      '};',
      'const rule = {',
      '  create(context) {',
      '    function helper() {}',
      '    return helper;',
      '  },',
      '};',
      'var bundle = wrap({',
      "  'file.js'(exports2) {",
      '    function inner() {}',
      '  },',
      '});',
      'function outer() {',
      '  function nested() {}',
      '}',
      '',
    ].join('\n'),
    'src/vendor.d.cts': 'export interface Prog {\n  size: number;\n}\nexport declare function make(): Prog;\n',
    'src/comment.cts': '// ADR 12 §5d and ADR 13 §OpenCode and ADR 14 §2\nexport const x = 1;\n',
  };
  let dir = '';
  let env: VerifyEnv;
  const fileFact = (rel: string): { path: string; hash: string } => ({ path: rel, hash: blobHash(dir, rel) });

  before(() => {
    dir = tempRepo(files);
    env = createVerifyEnv({ repoDir: dir, overlayPaths: new Set(Object.keys(files)) });
  });

  after(() => {
    removeTree(dir);
  });

  it('export verifier: a chained CommonJS assignment exports each name at its own span', () => {
    const chain = files['src/chain.cjs'] as string;
    const base = { stratum: 'export' as const, key: 'k', ...fileFact('src/chain.cjs'), local: null, fromPath: null };
    assert.equal(verifyExport({ ...base, name: 'EVENTS', span: spanOfText(chain, 'exports.EVENTS = void 0') }, env).verdict, 'correct');
    assert.equal(verifyExport({ ...base, name: 'SaxesParser', span: spanOfText(chain, 'exports.SaxesParser = exports.EVENTS = void 0;') }, env).verdict, 'correct');
    assert.equal(verifyExport({ ...base, name: 'OTHER', span: spanOfText(chain, 'exports.EVENTS = void 0') }, env).verdict, 'wrong');
  });

  it('definition verifier: qualified names follow the documented scoping, not every enclosing declaration', () => {
    const scopes = files['src/scopes.cjs'] as string;
    const base = { stratum: 'definition' as const, key: 'k', ...fileFact('src/scopes.cjs') };
    const check = (needle: string, kind: string, name: string, qualifiedName: string): string =>
      verifyDefinition({ ...base, name, qualifiedName, kind, span: spanOfText(scopes, needle) }, env).verdict;
    // A class expression is not a class definition, so its members carry no container.
    assert.equal(check('static MAX = 1;', 'property', 'MAX', 'MAX'), 'correct');
    assert.equal(check('static isPrint() {}', 'method', 'isPrint', 'isPrint'), 'correct');
    assert.equal(check('static MAX = 1;', 'property', 'MAX', 'Unicode.MAX'), 'wrong');
    // An object literal method is not a definition; the top-level constant around it is the container.
    assert.equal(check('function helper() {}', 'function', 'helper', 'rule.helper'), 'correct');
    assert.equal(check('function helper() {}', 'function', 'helper', 'create.helper'), 'wrong');
    assert.equal(check('function inner() {}', 'function', 'inner', 'bundle.inner'), 'correct');
    // A function declaration is a container.
    assert.equal(check('function nested() {}', 'function', 'nested', 'outer.nested'), 'correct');
    assert.equal(check('function nested() {}', 'function', 'nested', 'nested'), 'wrong');
  });

  it('reference edge verifier: a site in a declaration file is checked in the program that includes it', () => {
    const vendor = files['src/vendor.d.cts'] as string;
    const fact = {
      stratum: 'reference_edge' as const,
      key: 'k',
      ...fileFact('src/vendor.d.cts'),
      name: 'Prog',
      targetPath: 'src/vendor.d.cts',
      targetQualifiedName: 'Prog',
      targetKind: 'interface',
      resolver: 'typescript',
      span: spanOfText(vendor, 'Prog;'),
    };
    // The site is the `Prog` in `make(): Prog;`: the span without the semicolon.
    const site = { ...fact.span, endColumn: fact.span.endColumn - 1 };
    assert.equal(verifyReferenceEdge({ ...fact, span: site }, env).verdict, 'correct', verifyReferenceEdge({ ...fact, span: site }, env).reason);
    assert.equal(verifyReferenceEdge({ ...fact, span: site, targetQualifiedName: 'Other' }, env).verdict, 'wrong');
  });

  it('citation verifier: a stored section detail may be longer than the digits the oracle reads', () => {
    const comment = files['src/comment.cts'] as string;
    const base = { stratum: 'citation' as const, key: 'k', ...fileFact('src/comment.cts') };
    assert.equal(verifyCitation({ ...base, number: 12, detail: '§5d', span: spanOfText(comment, 'ADR 12 §5d') }, env).verdict, 'correct');
    assert.equal(verifyCitation({ ...base, number: 13, detail: '§OpenCode', span: spanOfText(comment, 'ADR 13 §OpenCode') }, env).verdict, 'correct');
    assert.equal(verifyCitation({ ...base, number: 14, detail: '§2', span: spanOfText(comment, 'ADR 14 §2') }, env).verdict, 'correct');
    assert.equal(verifyCitation({ ...base, number: 13, detail: '§Other', span: spanOfText(comment, 'ADR 13 §OpenCode') }, env).verdict, 'wrong');
    assert.equal(verifyCitation({ ...base, number: 12, detail: null, span: spanOfText(comment, 'ADR 12 §5d') }, env).verdict, 'wrong');
  });
});

describe('edge-sample keeps its verifiers independent of atlas', () => {
  it('imports nothing from src/', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'edge-sample.ts'), 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*(import|export)\b[^'"]*\bfrom\s+['"]/.test(line) || /^\s*import\s+['"]/.test(line));
    assert.ok(imports.length > 3, 'the import lines were not found');
    for (const line of imports) {
      assert.doesNotMatch(line, /src\//, `an import reaches into src/: ${line}`);
      assert.doesNotMatch(line, /\.\.\/src|fact-store|query|reader/i, `an import of atlas code: ${line}`);
    }
    assert.ok(imports.some((line) => line.includes('./eval/oracle.ts')), 'the oracle helpers are the independent code');
  });

  it('opens the store through a read-only connection only', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'edge-sample.ts'), 'utf8');
    const opens = [...source.matchAll(/new DatabaseSync\(([^)]*)\)/g)];
    assert.ok(opens.length >= 1);
    for (const open of opens) assert.match(open[1] ?? '', /readOnly:\s*true/);
  });
});
