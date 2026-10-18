/**
 * ADR citations in the Query tools (plan 03-28, TSM-04, D-19, D-20): `kind: adr` on `code_refs` and `code_find`, the
 * `citations` section of `code_context`, the name forms, and the truthful `resolved`, `ambiguous` and `unresolved` statuses.
 *
 * The facts are made by hand (the extractor is tested in the grammar engine); the ADR directory is the tenant's own, over a
 * real temporary repository, so the join the tools do is the join production does.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { CitationGaps, CitationSite, FileFacts, LocalSymbol } from '../facts/index.ts';
import { createAdrDirectory } from '../tenant/index.ts';
import { blobId, createHarness } from './harness.test.ts';
import type { Harness } from './harness.test.ts';
import { normaliseAdrName } from './adr.ts';
import type { Query } from './index.ts';

const open: Harness[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.cleanup();
});

const span = (line: number, col: number, endCol: number): CitationSite['span'] => ({ startLine: line, startColumn: col, endLine: line, endColumn: endCol });

/** A function symbol whose definition spans lines `from` to `to`. */
const fn = (name: string, from: number, to: number): LocalSymbol => ({
  name,
  kind: 'function',
  qualifiedName: name,
  span: { startLine: from, startColumn: 0, endLine: to, endColumn: 1 },
  exported: true,
});

/**
 * Write a file and store its facts, with the citations given (lines and columns are the store's own, 0-based) and, when the
 * extractor could not keep every mention of the file, its citation gap.
 */
async function addCited(
  h: Harness,
  rel: string,
  content: string,
  symbols: readonly LocalSymbol[],
  citations: readonly CitationSite[],
  citationGaps?: CitationGaps,
): Promise<string> {
  h.repo.write(rel, content);
  const hash = blobId(content);
  const facts: FileFacts = {
    path: rel,
    contentHash: hash,
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols,
    refSites: [],
    imports: [],
    exports: [],
    ...(citations.length === 0 ? {} : { citations }),
    ...(citationGaps === undefined ? {} : { citationGaps }),
    parse: { errorBytes: 0, totalBytes: content.length },
  };
  const result = await h.writer.commitFile({ worktree: h.dir, path: rel, hash, facts });
  assert.equal(result.status, 'committed', JSON.stringify(result.diagnostics));
  return hash;
}

interface Row {
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly detail?: string;
  readonly attachedTo: string | null;
  readonly confidence: string;
  readonly citation: string;
}
interface RefsData {
  readonly adr: { readonly number: number; readonly status: string; readonly files: readonly string[] };
  readonly results: readonly Row[];
}

/**
 * The fixture of the plan: two ADR files (1 and 2), `src/lib.cts` cites ADR-1 in a doc comment above `load`, `src/user.cts` cites
 * `ADR #2 §3` and `adr 0003` (there is no file for 3).
 */
async function adrWorld(): Promise<{ h: Harness; query: Query; reads: string[] }> {
  const h = await createHarness();
  open.push(h);
  h.repo.write('docs/adr/0001-first.md', '# first\n');
  h.repo.write('docs/adr/2-second.md', '# second\n');
  await addCited(h, 'src/lib.cts', '/** See ADR-1. */\nexport function load(): number {\n  return 1;\n}\n', [fn('load', 1, 3)], [
    { number: 1, span: span(0, 8, 13), enclosing: 0 },
  ]);
  await addCited(h, 'src/user.cts', '// ADR #2 §3 and adr 0003\nexport function use(): number {\n  return 2;\n}\n', [fn('use', 1, 3)], [
    { number: 2, detail: '§3', span: span(0, 3, 12) },
    { number: 3, span: span(0, 17, 25) },
  ]);
  const adr = createAdrDirectory({ tree: h.tree, dirsFor: () => ['docs/adr'] });
  // Every file Query asks to read, so a test can prove an ADR document is never one of them.
  const reads: string[] = [];
  const query = h.query({
    adr: { lookup: (worktree, number) => adr.lookup(worktree, number) },
    text: {
      readText: (worktree, rel, options) => {
        reads.push(rel);
        return h.tree.readText(worktree, rel, options);
      },
    },
  });
  return { h, query, reads };
}

const ask = (query: Query, h: Harness, kind: string, name: string, extra: Record<string, unknown> = {}) =>
  query.ask({ protocol: 1, kind, args: { name, kind: 'adr', repo: h.dir, ...extra }, worktree: h.dir });

describe('normaliseAdrName: name forms', () => {
  it('name forms: ADR-3473, adr 3473, ADR #3473, ADR#3473, #3473, 3473 and ADR-03473 are all 3473', () => {
    for (const text of ['ADR-3473', 'adr 3473', 'ADR #3473', 'ADR#3473', '#3473', '3473', 'ADR-03473', 'Adr-3473', '  ADR-3473  ', 'adr-0003473']) {
      assert.equal(normaliseAdrName(text), 3473, JSON.stringify(text));
    }
    assert.equal(normaliseAdrName('ADR-1'), 1);
    assert.equal(normaliseAdrName('99999999999'), 99_999_999_999);
  });

  it('invalid names: no digits, a letter, a sign, nothing, zero and a 12-digit number are refused', () => {
    for (const text of ['ADR-', 'ADR-x', 'ADR-3x', '-5', '+5', '', '   ', 'ADR - 3', 'ADR 3 4', '123456789012', 'ADR-0', '0', '3.5', 'ADR--3', '##3', 'ADR# 3']) {
      assert.equal(normaliseAdrName(text), null, JSON.stringify(text));
    }
  });
});

describe('code_refs kind adr: which code cites ADR N', () => {
  it('resolved: the citation site with its line, the symbol it is attached to, EXTRACTED confidence and the ADR file', async () => {
    const { h, query, reads } = await adrWorld();
    const envelope = await ask(query, h, 'code_refs', 'ADR-1');
    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.ok(reads.length > 0 && reads.every((rel) => !rel.startsWith('docs/')), `only source files are read, got ${reads.join(', ')}`);
    assert.equal(envelope.schema, 'gsd-atlas.code-refs/1');
    const data = envelope.data as RefsData;
    assert.deepEqual(data.adr, { number: 1, status: 'resolved', files: ['docs/adr/0001-first.md'] });
    assert.equal(data.results.length, 1);
    const [row] = data.results;
    assert.deepEqual(
      { path: row?.path, line: row?.line, col: row?.col, attachedTo: row?.attachedTo, confidence: row?.confidence, detail: row?.detail },
      { path: 'src/lib.cts', line: 1, col: 9, attachedTo: 'load', confidence: 'EXTRACTED', detail: undefined },
    );
    const cite = envelope.citations?.find((entry) => entry.id === row?.citation);
    assert.ok(cite !== undefined);
    assert.match(cite.debug, /^cit\/src%2Flib\.cts\/[0-9a-f]{40}\/0$/);
    assert.equal(cite.line, 1);
    assert.equal(cite.confidence, 'EXTRACTED');
    assert.equal(envelope.untrusted_text?.entries.length, 1, 'the matched comment line is the one fenced text');
    assert.match(envelope.untrusted_text?.entries[0]?.text ?? '', /See ADR-1\./);
    assert.deepEqual(envelope.diagnostics, []);
    assert.equal(envelope.degraded, undefined);
  });

  it('unresolved: a number cited but with no ADR file keeps every citation and says unresolved, with no files', async () => {
    const { h, query } = await adrWorld();
    const envelope = await ask(query, h, 'code_refs', 'adr-3');
    assert.equal(envelope.ok, true);
    const data = envelope.data as RefsData;
    assert.deepEqual(data.adr, { number: 3, status: 'unresolved', files: [] });
    assert.deepEqual(data.results.map((row) => [row.path, row.line, row.col]), [['src/user.cts', 1, 18]]);
    assert.notEqual(data.results[0]?.confidence, 'EXTRACTED', 'a citation with no file to link to is not an EXTRACTED link');
    assert.equal((envelope.hints ?? []).length, 0, 'citations were found, so there is no hint that none exist');
  });

  it('detail kept: the section suffix of the mention is part of the row', async () => {
    const { h, query } = await adrWorld();
    const data = (await ask(query, h, 'code_refs', '2')).data as RefsData;
    assert.deepEqual(data.adr, { number: 2, status: 'resolved', files: ['docs/adr/2-second.md'] });
    assert.equal(data.results[0]?.detail, '§3');
    assert.equal(data.results[0]?.attachedTo, null, 'a file-level mention is attached to nothing');
  });

  it('attached symbol: a doc comment citation names the definition it documents, a trailing one names nothing', async () => {
    const { h, query } = await adrWorld();
    const lib = (await ask(query, h, 'code_refs', '#1')).data as RefsData;
    assert.equal(lib.results[0]?.attachedTo, 'load');
    const user = (await ask(query, h, 'code_refs', 'ADR #2')).data as RefsData;
    assert.equal(user.results[0]?.attachedTo, null);
  });

  it('name forms: every spelling of the number asks the same question and gets the same answer', async () => {
    const { h, query } = await adrWorld();
    const base = JSON.stringify(((await ask(query, h, 'code_refs', 'ADR-1')) as { data: unknown }).data);
    for (const text of ['adr 1', 'ADR #1', 'ADR#1', '#1', '1', 'ADR-0001']) {
      assert.equal(JSON.stringify(((await ask(query, h, 'code_refs', text)) as { data: unknown }).data), base, text);
    }
  });

  it('invalid names: a name that is not an ADR number is refused with one fixed invalid_args message that does not echo it', async () => {
    const { h, query } = await adrWorld();
    const seen = new Set<string>();
    for (const text of ['ADR-', 'ADR-x', '-5', '123456789012', 'not a number <script>']) {
      const envelope = await ask(query, h, 'code_refs', text);
      assert.equal(envelope.ok, false, text);
      assert.equal(envelope.diagnostics[0]?.code, 'invalid_args', text);
      seen.add(envelope.diagnostics[0]?.message ?? '');
    }
    assert.equal(seen.size, 1, 'one fixed sentence for every input, so none of them is echoed');
    const found = await ask(query, h, 'code_find', 'ADR-');
    assert.equal(found.diagnostics[0]?.code, 'invalid_args');
    assert.equal(found.diagnostics[0]?.message, [...seen][0]);
  });

  it('without an ADR port every number is unresolved (no directory is known) and the citations are still listed', async () => {
    const { h } = await adrWorld();
    const bare = h.query();
    const data = (await ask(bare, h, 'code_refs', 'ADR-1')).data as RefsData;
    assert.deepEqual(data.adr, { number: 1, status: 'unresolved', files: [] });
    assert.equal(data.results.length, 1);
  });

  it('a number nobody cites is an empty list with a hint, and the ADR file it names is still reported', async () => {
    const { h, query } = await adrWorld();
    const envelope = await ask(query, h, 'code_refs', 'ADR-9');
    const data = envelope.data as RefsData;
    assert.deepEqual(data.adr, { number: 9, status: 'unresolved', files: [] });
    assert.deepEqual(data.results, []);
    assert.equal((envelope.hints ?? []).length, 1);
    // A file that exists but is cited nowhere: resolved, no citations. (A pause, so the directory's mtime moves on a coarse clock.)
    await new Promise((resolve) => setTimeout(resolve, 30));
    h.repo.write('docs/adr/0009-nine.md', '# nine\n');
    const nine = (await ask(query, h, 'code_refs', 'ADR-9')).data as RefsData;
    assert.deepEqual(nine.adr, { number: 9, status: 'resolved', files: ['docs/adr/0009-nine.md'] });
    assert.deepEqual(nine.results, []);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 3: code_find kind adr, code_context citations, cit handles in code_explain, ambiguity, paging

interface FindData {
  readonly number: number;
  readonly status: string;
  readonly citations: number;
  readonly listTruncated?: true;
  readonly results: ReadonlyArray<{ readonly path: string; readonly number: number; readonly confidence: string; readonly citation: string }>;
}

/** gsd-core's shape: duplicate ids 0010 (two files) and 0011, a citation of 10, 11 and 12 (no file), and a number cited many times. */
async function dupWorld(): Promise<{ h: Harness; query: Query; reads: string[] }> {
  const h = await createHarness();
  open.push(h);
  h.repo.write('docs/adr/0010-b-second.md', '# b\n');
  h.repo.write('docs/adr/0010-a-first.md', '# a\n');
  h.repo.write('docs/adr/0011-only.md', '# c\n');
  await addCited(h, 'src/a.cts', '/** ADR-10. */\nexport function ten(): number {\n  return 10;\n}\n', [fn('ten', 1, 3)], [{ number: 10, span: span(0, 4, 10), enclosing: 0 }]);
  await addCited(h, 'src/b.cts', '// ADR #11 §2\nexport function eleven(): number {\n  return 11;\n}\n', [fn('eleven', 1, 3)], [
    { number: 11, detail: '§2', span: span(0, 3, 13) },
  ]);
  await addCited(h, 'src/c.cts', '// ADR-12\nexport function twelve(): number {\n  return 12;\n}\n', [fn('twelve', 1, 3)], [{ number: 12, span: span(0, 3, 9) }]);
  // Seven mentions of ADR 5, one per line, for the paging cases.
  const lines = Array.from({ length: 7 }, (_, i) => `// ADR-5 line ${String(i)}`).join('\n');
  await addCited(h, 'src/many.cts', `${lines}\n`, [], Array.from({ length: 7 }, (_, i) => ({ number: 5, span: span(i, 3, 8) })));
  const adr = createAdrDirectory({ tree: h.tree, dirsFor: () => ['docs/adr'] });
  const reads: string[] = [];
  const query = h.query({
    adr: { lookup: (worktree, number) => adr.lookup(worktree, number) },
    text: {
      readText: (worktree, rel, options) => {
        reads.push(rel);
        return h.tree.readText(worktree, rel, options);
      },
    },
  });
  return { h, query, reads };
}

describe('code_find kind adr: where is ADR N', () => {
  it('find resolved: the ADR file as an item with its path, number, a citation at line 1 and EXTRACTED confidence, and the citation count', async () => {
    const { h, query, reads } = await adrWorld();
    const envelope = await ask(query, h, 'code_find', 'ADR-1');
    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.equal(envelope.schema, 'gsd-atlas.code-find/1');
    const data = envelope.data as FindData;
    assert.deepEqual({ number: data.number, status: data.status, citations: data.citations }, { number: 1, status: 'resolved', citations: 1 });
    assert.equal(data.results.length, 1);
    assert.deepEqual({ path: data.results[0]?.path, number: data.results[0]?.number, confidence: data.results[0]?.confidence }, { path: 'docs/adr/0001-first.md', number: 1, confidence: 'EXTRACTED' });
    const cite = envelope.citations?.find((entry) => entry.id === data.results[0]?.citation);
    assert.deepEqual({ path: cite?.path, line: cite?.line, col: cite?.col, confidence: cite?.confidence }, { path: 'docs/adr/0001-first.md', line: 1, col: 1, confidence: 'EXTRACTED' });
    assert.equal(cite?.text_ref, undefined, 'an ADR document is never read, so there is no text');
    assert.equal(envelope.untrusted_text, undefined);
    assert.equal(envelope.degraded, undefined, 'a document without text is not a stale answer');
    assert.deepEqual(envelope.hints ?? [], []);
    assert.ok(!reads.some((rel) => rel.startsWith('docs/')), 'no ADR file is read');
  });

  it('find ambiguous: two files with one number are both returned with INFERRED confidence, sorted, and the status says ambiguous', async () => {
    const { h, query } = await dupWorld();
    const ten = (await ask(query, h, 'code_find', 'ADR-10')).data as FindData;
    assert.equal(ten.status, 'ambiguous');
    assert.deepEqual(ten.results.map((row) => [row.path, row.confidence]), [
      ['docs/adr/0010-a-first.md', 'INFERRED'],
      ['docs/adr/0010-b-second.md', 'INFERRED'],
    ]);
    const eleven = (await ask(query, h, 'code_find', '11')).data as FindData;
    assert.equal(eleven.status, 'resolved');
    assert.deepEqual(eleven.results.map((row) => [row.path, row.confidence]), [['docs/adr/0011-only.md', 'EXTRACTED']]);
    // The statuses of code_refs agree.
    const refs = (await ask(query, h, 'code_refs', 'ADR-10')).data as RefsData;
    assert.equal(refs.adr.status, 'ambiguous');
    assert.deepEqual(refs.adr.files, ['docs/adr/0010-a-first.md', 'docs/adr/0010-b-second.md']);
    assert.equal(refs.results[0]?.confidence, 'INFERRED', 'a citation of a duplicated id links to each file by name only');
  });

  it('find unresolved with count: no file gives no items, the status unresolved, how many citations exist and a hint', async () => {
    const { h, query } = await dupWorld();
    const envelope = await ask(query, h, 'code_find', 'adr-12');
    const data = envelope.data as FindData;
    assert.deepEqual({ status: data.status, citations: data.citations, results: data.results }, { status: 'unresolved', citations: 1, results: [] });
    assert.equal((envelope.hints ?? []).length, 1);
    // A number nobody cites and nobody documents: unresolved, count 0, still an ok answer.
    const none = (await ask(query, h, 'code_find', 'ADR-404')).data as FindData;
    assert.deepEqual({ status: none.status, citations: none.citations, results: none.results }, { status: 'unresolved', citations: 0, results: [] });
  });

  it('paging: a number cited more often than the page keeps its order across pages and ends cleanly', async () => {
    const { h, query } = await dupWorld();
    const seen: number[] = [];
    let more: string | undefined;
    let pages = 0;
    do {
      const envelope = await ask(query, h, 'code_refs', 'ADR-5', { limit: 3, ...(more === undefined ? {} : { more }) });
      assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
      const data = envelope.data as RefsData;
      assert.ok(data.results.length <= 3);
      seen.push(...data.results.map((row) => row.line));
      more = envelope.more;
      pages += 1;
    } while (more !== undefined && pages < 10);
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7], 'every citation exactly once, in line order');
    assert.equal(pages, 3);
    // A cursor from another question is refused.
    const first = await ask(query, h, 'code_refs', 'ADR-5', { limit: 3 });
    const other = await ask(query, h, 'code_refs', 'ADR-10', { limit: 3, more: first.more ?? '' });
    assert.equal(other.ok, false);
    assert.equal(other.diagnostics[0]?.code, 'bad_cursor');
  });

  it('paging: ambiguous files page too, and a cursor continues after the last file', async () => {
    const { h, query } = await dupWorld();
    const first = await ask(query, h, 'code_find', 'ADR-10', { limit: 1 });
    const firstData = first.data as FindData;
    assert.deepEqual(firstData.results.map((row) => row.path), ['docs/adr/0010-a-first.md']);
    assert.ok(first.more !== undefined);
    const second = await ask(query, h, 'code_find', 'ADR-10', { limit: 1, more: first.more as string });
    assert.deepEqual((second.data as FindData).results.map((row) => row.path), ['docs/adr/0010-b-second.md']);
    assert.equal(second.more, undefined);
  });

  it('the tool descriptions say that kind adr asks about ADRs, in fixed text', async () => {
    const { codeFindSchema, codeRefsSchema } = await import('./tools.ts');
    for (const schema of [codeFindSchema, codeRefsSchema]) {
      const text = schema.shape.kind.description ?? '';
      assert.match(text, /\bkind adr\b/);
      assert.ok(!/[\n${}]/.test(text), 'a fixed sentence: nothing is interpolated into it');
    }
  });
});

describe('code_context citations: the ADR mentions attached to a symbol', () => {
  interface ContextData {
    readonly results: ReadonlyArray<{ readonly section: string; readonly name: string }>;
    readonly citations?: ReadonlyArray<{ readonly number: number; readonly detail?: string; readonly status: string; readonly files: readonly string[]; readonly citation: string; readonly line: number }>;
  }

  it('context citations: a symbol lists its attached citations with the status and files of each number, sorted by line', async () => {
    const h = await createHarness();
    open.push(h);
    h.repo.write('docs/adr/0001-first.md', '# first\n');
    const content = '/** ADR-1 §2 and ADR-3 */\nexport function load(): number {\n  // ADR-2\n  return 1;\n}\n';
    await addCited(h, 'src/lib.cts', content, [fn('load', 1, 4)], [
      { number: 3, span: span(0, 17, 22), enclosing: 0 },
      { number: 1, detail: '§2', span: span(0, 4, 12), enclosing: 0 },
      { number: 2, span: span(2, 5, 10), enclosing: 0 },
    ]);
    const adr = createAdrDirectory({ tree: h.tree, dirsFor: () => ['docs/adr'] });
    const query = h.query({ adr: { lookup: (worktree, number) => adr.lookup(worktree, number) } });
    const envelope = await query.ask({ protocol: 1, kind: 'code_context', args: { name: 'load', repo: h.dir }, worktree: h.dir });
    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    const data = envelope.data as ContextData;
    assert.deepEqual(
      data.citations?.map((entry) => [entry.number, entry.detail, entry.status, entry.files, entry.line]),
      [
        [1, '§2', 'resolved', ['docs/adr/0001-first.md'], 1],
        [3, undefined, 'unresolved', [], 1],
        [2, undefined, 'unresolved', [], 3],
      ],
      'sorted by line then column',
    );
    for (const entry of data.citations ?? []) {
      const cite = envelope.citations?.find((each) => each.id === entry.citation);
      assert.match(cite?.debug ?? '', /^cit\/src%2Flib\.cts\/[0-9a-f]{40}\/[0-9]+$/);
    }
    assert.equal(data.results[0]?.section, 'definition', 'the definition still comes first');
  });

  it('context citations: absent when the symbol has none', async () => {
    const { h, query } = await adrWorld();
    await addCited(h, 'src/plain.cts', 'export function plain(): number {\n  return 1;\n}\n', [fn('plain', 0, 2)], []);
    const envelope = await query.ask({ protocol: 1, kind: 'code_context', args: { name: 'plain', repo: h.dir }, worktree: h.dir });
    assert.equal(envelope.ok, true);
    assert.ok(!('citations' in (envelope.data as object)));
  });

  it('context citations: pages like every other section and the definition is never cut for them', async () => {
    const { h, query } = await adrWorld();
    const many = Array.from({ length: 6 }, (_, i) => ({ number: 20 + i, span: span(0, 4 + i, 9 + i), enclosing: 0 as const }));
    await addCited(h, 'src/busy.cts', '/* ADRs */\nexport function busy(): number {\n  return 1;\n}\n', [fn('busy', 1, 3)], many);
    const numbers: number[] = [];
    let more: string | undefined;
    let pages = 0;
    do {
      const envelope = await query.ask({
        protocol: 1,
        kind: 'code_context',
        args: { name: 'busy', repo: h.dir, limit: 3, ...(more === undefined ? {} : { more }) },
        worktree: h.dir,
      });
      assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
      const data = envelope.data as ContextData;
      if (pages === 0) assert.equal(data.results[0]?.section, 'definition', 'the definition leads the first page');
      numbers.push(...(data.citations ?? []).map((entry) => entry.number));
      more = envelope.more;
      pages += 1;
    } while (more !== undefined && pages < 10);
    assert.deepEqual(numbers, [20, 21, 22, 23, 24, 25], 'every citation once, in position order');
    assert.equal(pages, 3, 'one definition and six citations make seven items: three pages of at most three');
  });
});

// ---------------------------------------------------------------------------------------------
// Task 5 (amendment of 2026-10-18): an ADR answer says when the index could not store every citation

const GAP_CODE = 'citation_comment_too_long';
const MAY_BE_MISSING = (files: number): string =>
  `Citations may be missing from this answer: ${files === 1 ? '1 file has' : `${String(files)} files have`} ADR mentions that were not indexed (a comment over the comment size bound, or more than 200 mentions in one file).`;
const MAY_EXIST = (files: number): string =>
  `No citation of this ADR was found, but ${files === 1 ? '1 file has' : `${String(files)} files have`} ADR mentions that were not indexed, so a citation may exist that this answer cannot show.`;

/** The fixture of the plan plus `gapFiles` files whose facts carry a citation gap; a marker in their text that no answer may repeat. */
async function gapWorld(gapFiles: number): Promise<{ h: Harness; query: Query }> {
  const { h, query } = await adrWorld();
  for (let index = 0; index < gapFiles; index += 1) {
    await addCited(
      h,
      `src/gap${String(index + 1)}.cts`,
      `/* HEADER-MARKER-${String(index + 1)} ADR-99 */\nexport function gapped${String(index + 1)}(): number {\n  return 1;\n}\n`,
      [fn(`gapped${String(index + 1)}`, 1, 3)],
      [],
      index === 0 ? { skippedComments: 1, capped: false } : { skippedComments: 0, capped: true },
    );
  }
  return { h, query };
}

const gapNotes = (envelope: { readonly diagnostics: ReadonlyArray<{ readonly code: string }> }) => envelope.diagnostics.filter((d) => d.code === GAP_CODE);

describe('the citation gap diagnostic on kind adr answers', () => {
  it('gap diagnostic on refs: exactly one fixed info diagnostic with the worktree-wide file count, no subject', async () => {
    const { h, query } = await gapWorld(2);
    const envelope = await ask(query, h, 'code_refs', 'ADR-1');
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.diagnostics, [{ code: GAP_CODE, severity: 'info', message: MAY_BE_MISSING(2) }]);
    assert.equal(envelope.degraded, undefined, 'a diagnostic, not a degraded code');
    assert.equal((envelope.data as RefsData).results.length, 1, 'the answer itself is unchanged');
  });

  it('gap diagnostic on refs: every page of a cursor-paged answer carries it', async () => {
    const { h, query } = await gapWorld(1);
    // Seven mentions of ADR 5 in one file so the answer pages.
    const lines = Array.from({ length: 7 }, (_, i) => `// ADR-5 line ${String(i)}`).join('\n');
    await addCited(h, 'src/many.cts', `${lines}\n`, [], Array.from({ length: 7 }, (_, i) => ({ number: 5, span: span(i, 3, 8) })));
    let more: string | undefined;
    let pages = 0;
    do {
      const envelope = await ask(query, h, 'code_refs', 'ADR-5', { limit: 3, ...(more === undefined ? {} : { more }) });
      assert.deepEqual(gapNotes(envelope).length, 1, `page ${String(pages + 1)}`);
      assert.equal(envelope.diagnostics.find((d) => d.code === GAP_CODE)?.message, MAY_BE_MISSING(1));
      more = envelope.more;
      pages += 1;
    } while (more !== undefined && pages < 10);
    assert.equal(pages, 3);
  });

  it('gap diagnostic on find: the ADR file answer carries it too, with the count of the worktree', async () => {
    const { h, query } = await gapWorld(2);
    const found = await ask(query, h, 'code_find', 'ADR-1');
    assert.deepEqual(found.diagnostics, [{ code: GAP_CODE, severity: 'info', message: MAY_BE_MISSING(2) }]);
    assert.equal((found.data as FindData).status, 'resolved');
  });

  it('unresolved with gaps says may exist: a number nobody was found to cite never reads as nobody cites it', async () => {
    const { h, query } = await gapWorld(2);
    for (const kind of ['code_refs', 'code_find']) {
      const none = await ask(query, h, kind, 'ADR-404');
      assert.deepEqual(none.diagnostics, [{ code: GAP_CODE, severity: 'info', message: MAY_EXIST(2) }], kind);
    }
    // A resolved ADR that nothing was found to cite says it too (the document exists; the citation may not be shown).
    await new Promise((resolve) => setTimeout(resolve, 30));
    h.repo.write('docs/adr/0009-nine.md', '# nine\n');
    const nine = await ask(query, h, 'code_find', 'ADR-9');
    assert.equal((nine.data as FindData).status, 'resolved');
    assert.deepEqual(nine.diagnostics, [{ code: GAP_CODE, severity: 'info', message: MAY_EXIST(2) }]);
    // An unresolved number whose citations were found is a listing of citations, not an absence.
    const three = await ask(query, h, 'code_refs', 'ADR-3');
    assert.deepEqual(three.diagnostics, [{ code: GAP_CODE, severity: 'info', message: MAY_BE_MISSING(2) }]);
  });

  it('gap diagnostic: one file reads "1 file has"', async () => {
    const { h, query } = await gapWorld(1);
    assert.equal(gapNotes(await ask(query, h, 'code_refs', 'ADR-1'))[0] === undefined, false);
    assert.equal((await ask(query, h, 'code_refs', 'ADR-1')).diagnostics[0]?.message, MAY_BE_MISSING(1));
    assert.equal((await ask(query, h, 'code_refs', 'ADR-404')).diagnostics[0]?.message, MAY_EXIST(1));
  });

  it('no gap no diagnostic: a worktree without a gap gives the answers of before, with no diagnostics', async () => {
    const { h, query } = await adrWorld();
    for (const [kind, name] of [['code_refs', 'ADR-1'], ['code_find', 'ADR-1'], ['code_refs', 'ADR-404'], ['code_find', 'ADR-404']] as const) {
      const envelope = await ask(query, h, kind, name);
      assert.deepEqual(envelope.diagnostics, [], `${kind} ${name}`);
    }
    const context = await query.ask({ protocol: 1, kind: 'code_context', args: { name: 'load', repo: h.dir }, worktree: h.dir });
    assert.deepEqual(context.diagnostics, []);
  });

  it('context only for its own file: code_context carries the diagnostic when the symbol file holds a gap, and not when only another file does', async () => {
    const { h, query } = await gapWorld(2);
    const own = await query.ask({ protocol: 1, kind: 'code_context', args: { name: 'gapped1', repo: h.dir }, worktree: h.dir });
    assert.deepEqual(own.diagnostics, [{ code: GAP_CODE, severity: 'info', message: MAY_BE_MISSING(1) }]);
    const other = await query.ask({ protocol: 1, kind: 'code_context', args: { name: 'load', repo: h.dir }, worktree: h.dir });
    assert.deepEqual(other.diagnostics, [], 'load lives in a file without a gap: another file with one does not touch it');
    assert.equal(own.degraded, undefined);
  });

  it('diagnostic holds no path: the full envelopes contain neither the names of the gap files nor the text of their header blocks', async () => {
    const { h, query } = await gapWorld(2);
    const envelopes = [
      await ask(query, h, 'code_refs', 'ADR-1'),
      await ask(query, h, 'code_find', 'ADR-1'),
      await ask(query, h, 'code_refs', 'ADR-99'),
      await ask(query, h, 'code_find', 'ADR-404'),
      await query.ask({ protocol: 1, kind: 'code_context', args: { name: 'load', repo: h.dir }, worktree: h.dir }),
    ];
    for (const envelope of envelopes) {
      const text = JSON.stringify(envelope);
      for (const leak of ['gap1', 'gap2', 'gapped1', 'HEADER-MARKER']) {
        // ADR-99 is cited inside the gap files' header blocks, which are comments the fixture did not store; nothing may name it.
        assert.equal(text.includes(leak), false, `${leak} leaked into ${envelope.schema}`);
      }
    }
    const note = (await ask(query, h, 'code_refs', 'ADR-1')).diagnostics[0];
    assert.equal(note?.subject, undefined);
    assert.ok(!/\d{2,}/.test((note?.message ?? '').replace('200', '')), 'one integer at most: no number from a skipped comment');
  });

  it('DEGRADED_CODES keeps its fourteen codes: the gap is not a fifteenth', async () => {
    const { DEGRADED_CODES } = await import('../facts/index.ts');
    assert.equal(DEGRADED_CODES.length, 14);
    assert.ok(!(DEGRADED_CODES as readonly string[]).includes(GAP_CODE));
  });
});

describe('cit handles in code_explain', () => {
  it('cit handle explained: kind citation, the grammar extractor, no resolution, the number and the ADR status', async () => {
    const { h, query } = await adrWorld();
    const refs = await ask(query, h, 'code_refs', 'ADR-1');
    const handle = refs.citations?.[0]?.debug ?? '';
    assert.match(handle, /^cit\//);
    const explained = await query.ask({ protocol: 1, kind: 'code_explain', args: { handle, repo: h.dir }, worktree: h.dir });
    assert.equal(explained.ok, true, JSON.stringify(explained.diagnostics));
    const data = explained.data as {
      explanation: { kind: string; handle: string; fact: { extractor: string; tier: string; confidence: string; path: string }; resolution: unknown; citation?: { number: number; detail?: string } };
      adr?: { number: number; status: string; files: string[] };
    };
    assert.equal(data.explanation.kind, 'citation');
    assert.equal(data.explanation.handle, handle);
    assert.deepEqual({ extractor: data.explanation.fact.extractor, tier: data.explanation.fact.tier, confidence: data.explanation.fact.confidence, path: data.explanation.fact.path }, {
      extractor: 'grammar:typescript@0.23.2',
      tier: 'grammar',
      confidence: 'EXTRACTED',
      path: 'src/lib.cts',
    });
    assert.equal(data.explanation.resolution, null);
    assert.deepEqual(data.explanation.citation, { number: 1 });
    assert.deepEqual(data.adr, { number: 1, status: 'resolved', files: ['docs/adr/0001-first.md'] });
    assert.equal(explained.untrusted_text, undefined, 'no source text is returned');
    // A mention with a section detail carries it.
    const two = await ask(query, h, 'code_refs', '2');
    const detailed = await query.ask({ protocol: 1, kind: 'code_explain', args: { handle: two.citations?.[0]?.debug ?? '', repo: h.dir }, worktree: h.dir });
    assert.deepEqual((detailed.data as { explanation: { citation?: unknown } }).explanation.citation, { number: 2, detail: '§3' });
  });

  it('cit handle explained: a handle of a file that changed since is stale_handle, and a made-up one is invalid_handle', async () => {
    const { h, query } = await adrWorld();
    const refs = await ask(query, h, 'code_refs', 'ADR-1');
    const handle = refs.citations?.[0]?.debug ?? '';
    await addCited(h, 'src/lib.cts', '/** See ADR-1. Edited. */\nexport function load(): number {\n  return 2;\n}\n', [fn('load', 1, 3)], [
      { number: 1, span: span(0, 8, 13), enclosing: 0 },
    ]);
    const stale = await query.ask({ protocol: 1, kind: 'code_explain', args: { handle, repo: h.dir }, worktree: h.dir });
    assert.equal(stale.ok, false);
    assert.equal(stale.diagnostics[0]?.code, 'stale_handle');
    const current = (await ask(query, h, 'code_refs', 'ADR-1')).citations?.[0]?.debug ?? '';
    assert.notEqual(current, handle, 'the file changed, so the handle changed');
    for (const bad of [current.replace(/\/[0-9]+$/, '/99'), 'cit/src%2Flib.cts/abc/0', 'cit/../x/' + 'a'.repeat(40) + '/0']) {
      const answer = await query.ask({ protocol: 1, kind: 'code_explain', args: { handle: bad, repo: h.dir }, worktree: h.dir });
      assert.equal(answer.ok, false, bad);
      assert.equal(answer.diagnostics[0]?.code, 'invalid_handle', bad);
    }
  });
});
