/**
 * ADR citations in the Query tools (plan 03-28, TSM-04, D-19, D-20): `kind: adr` on `code_refs` and `code_find`, the
 * `citations` section of `code_context`, the name forms, and the truthful `resolved`, `ambiguous` and `unresolved` statuses.
 *
 * The facts are made by hand (the extractor is tested in the grammar engine); the ADR directory is the tenant's own, over a
 * real temporary repository, so the join the tools do is the join production does.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { CitationSite, FileFacts, LocalSymbol } from '../facts/index.ts';
import { createAdrDirectory } from '../tenant/adr.ts';
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

/** Write a file and store its facts, with the citations given (lines and columns are the store's own, 0-based). */
async function addCited(h: Harness, rel: string, content: string, symbols: readonly LocalSymbol[], citations: readonly CitationSite[]): Promise<string> {
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
      assert.ok(!envelope.diagnostics[0]?.message.includes(text), 'the message does not echo the name');
      seen.add(envelope.diagnostics[0]?.message ?? '');
    }
    assert.equal(seen.size, 1, 'one fixed sentence');
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
