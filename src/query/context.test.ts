import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { EmitLookup, Envelope, ProjectContextProvider, RefKind, Request } from '../facts/index.ts';
import { estimateTokens } from './budget.ts';
import { addCaller, defineFn, nameOf, where } from './fixtures.test.ts';
import { createHarness } from './harness.test.ts';
import type { Harness } from './harness.test.ts';

async function world(t: TestContext): Promise<Harness> {
  const harness = await createHarness();
  t.after(() => harness.cleanup());
  return harness;
}

interface ContextItem {
  readonly section: string;
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly confidence: string;
  readonly citation: string;
  readonly style?: string;
  readonly bindings?: readonly { imported: string; local: string }[];
  readonly local?: string;
  readonly enclosing?: string | null;
  readonly tier?: string;
  readonly target?: string;
}

interface Alternative {
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
  readonly handle: string;
}

interface ContextData {
  readonly results: readonly ContextItem[];
  readonly alternatives: readonly Alternative[];
  readonly file?: { readonly path: string; readonly emittedAs?: readonly string[] };
}

const dataOf = (envelope: Envelope): ContextData => envelope.data as ContextData;
const sectionsOf = (envelope: Envelope): string[] => dataOf(envelope).results.map((item) => item.section);

function contextRequest(h: Harness, args: Record<string, unknown>): Request {
  return { protocol: 1, kind: 'code_context', args: { repo: h.dir, ...args }, worktree: h.dir };
}

/**
 * A class with a field and two methods, an import of `util`, and two exports:
 *   line 2 `export class Parser {`, 3 `field`, 4 `parse`, 5 `reset`, 7 `export const VERSION`.
 */
const PARSER_TS = [
  '// parser.ts',
  "import { util } from './util';",
  'export class Parser {',
  '  field = 1;',
  '  parse(input) { return util(input); }',
  '  reset() {}',
  '}',
  'export const VERSION = 1;',
  '',
].join('\n');

async function addParser(h: Harness): Promise<void> {
  const cls = where(PARSER_TS, 'Parser');
  const field = where(PARSER_TS, 'field');
  const parse = where(PARSER_TS, 'parse(input)');
  const reset = where(PARSER_TS, 'reset()');
  const version = where(PARSER_TS, 'VERSION');
  await h.addFileWith('parser.ts', PARSER_TS, {
    symbols: [
      { name: 'Parser', kind: 'class', line: cls.line, col: cls.col, endLine: 6, endCol: 1, exported: true },
      { name: 'field', kind: 'property', qualifiedName: 'Parser.field', line: field.line, col: field.col, parent: 0 },
      { name: 'parse', kind: 'method', qualifiedName: 'Parser.parse', line: parse.line, col: parse.col, parent: 0 },
      { name: 'reset', kind: 'method', qualifiedName: 'Parser.reset', line: reset.line, col: reset.col, parent: 0 },
      { name: 'VERSION', kind: 'const', line: version.line, col: version.col, exported: true },
    ],
    imports: [{ path: './util', line: 1, style: 'es', bindings: [{ imported: 'util', local: 'util' }] }],
    exports: [
      { name: 'Parser', line: cls.line, col: cls.col },
      { name: 'VERSION', line: version.line, col: version.col },
    ],
  });
}

/** A file that imports `name` from the parser (`from` is the specifier) and uses it as `kind` says, inside `fn`. */
async function addUser(h: Harness, file: string, from: string, name: string, fn: string, kind: RefKind): Promise<void> {
  const content = `// ${file}\nimport { ${name} } from '${from}';\nexport function ${fn}() { return ${name}; }\n`;
  const decl = nameOf(content, fn);
  const use = where(content, `${name}; }`);
  await h.addFileWith(file, content, {
    symbols: [{ name: fn, kind: 'function', line: decl.line, col: decl.col, exported: true }],
    refs: [{ name, line: use.line, col: use.col, kind, enclosing: 0 }],
    imports: [{ path: from, line: 1, style: 'es', bindings: [{ imported: name, local: name }] }],
  });
}

describe('code_context: a symbol in the context of its file', () => {
  it('lists the definition, its members in source order, the imports, the exports and the references, in that priority order', async (t) => {
    const h = await world(t);
    await addParser(h);
    await addUser(h, 'app.ts', './parser', 'Parser', 'make', 'new');

    const envelope = await h.query().ask(contextRequest(h, { name: 'Parser' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.equal(envelope.schema, 'gsd-atlas.code-context/1');
    assert.deepEqual(sectionsOf(envelope), ['definition', 'child', 'child', 'child', 'import', 'export', 'export', 'reference']);
    const items = dataOf(envelope).results;
    assert.deepEqual(
      items.filter((item) => item.section === 'child').map((item) => [item.name, item.kind]),
      [
        ['field', 'property'],
        ['parse', 'method'],
        ['reset', 'method'],
      ],
    );
    const [definition] = items;
    assert.equal(definition?.name, 'Parser');
    assert.equal(definition?.kind, 'class');
    assert.equal(definition?.path, 'parser.ts');
    assert.equal(definition?.line, 3);
    assert.equal(definition?.confidence, 'EXTRACTED');

    const imported = items.find((item) => item.section === 'import');
    assert.equal(imported?.name, './util');
    assert.equal(imported?.style, 'es');
    assert.deepEqual(imported?.bindings, [{ imported: 'util', local: 'util' }]);
    assert.deepEqual(
      items.filter((item) => item.section === 'export').map((item) => item.name),
      ['Parser', 'VERSION'],
    );
    const reference = items.find((item) => item.section === 'reference');
    assert.equal(reference?.path, 'app.ts');
    assert.equal(reference?.kind, 'new');
    assert.equal(reference?.confidence, 'INFERRED');
    assert.equal(reference?.enclosing, 'make');
    assert.deepEqual(dataOf(envelope).alternatives, []);

    // Every item cites the file it came from; an item with a position also carries its fenced line.
    const citations = envelope.citations ?? [];
    assert.equal(citations.length, items.length);
    for (const item of items) {
      const cited = citations.find((citation) => citation.id === item.citation);
      assert.ok(cited !== undefined, `${item.section} ${item.name} has a citation`);
      assert.equal(cited.path, item.path);
      assert.equal(cited.line, item.line);
      assert.notEqual(cited.text_ref, undefined, `${item.section} ${item.name} has its line text`);
    }
    const nonce = envelope.untrusted_text?.nonce ?? '';
    const texts = (envelope.untrusted_text?.entries ?? []).map((entry) => entry.text);
    assert.ok(texts.includes(`BEGIN-UNTRUSTED-${nonce}\nexport class Parser {\nEND-UNTRUSTED-${nonce}`));
    assert.equal('truncated' in envelope, false);
  });

  it('a method has its class as the containing symbol and no children', async (t) => {
    const h = await world(t);
    await addParser(h);

    const envelope = await h.query().ask(contextRequest(h, { name: 'reset' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(sectionsOf(envelope).slice(0, 2), ['definition', 'parent']);
    assert.equal(sectionsOf(envelope).includes('child'), false);
    const parent = dataOf(envelope).results[1];
    assert.equal(parent?.name, 'Parser');
    assert.equal(parent?.kind, 'class');
    assert.equal(dataOf(envelope).results[0]?.name, 'reset');
  });

  it('never lists callees, cites_adr or tested_by, which are later work', async (t) => {
    const h = await world(t);
    await addParser(h);
    await addUser(h, 'app.ts', './parser', 'Parser', 'make', 'new');

    const envelope = await h.query().ask(contextRequest(h, { name: 'Parser' }));
    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.ok(dataOf(envelope).results.length > 3, 'the answer has content to scan');
    const text = JSON.stringify(envelope);

    for (const word of ['callees', 'cites_adr', 'tested_by']) assert.equal(text.includes(word), false, word);
  });

  it('takes the highest-ranked of several definitions and lists at most five others as alternatives', async (t) => {
    const h = await world(t);
    for (let index = 1; index <= 8; index += 1) await defineFn(h, `src/x${String(index)}.ts`, 'Thing');

    const envelope = await h.query().ask(contextRequest(h, { name: 'Thing' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.equal(dataOf(envelope).results[0]?.path, 'src/x1.ts');
    const { alternatives } = dataOf(envelope);
    assert.deepEqual(
      alternatives.map((alternative) => alternative.path),
      ['src/x2.ts', 'src/x3.ts', 'src/x4.ts', 'src/x5.ts', 'src/x6.ts'],
    );
    for (const alternative of alternatives) {
      assert.equal(alternative.name, 'Thing');
      assert.equal(alternative.kind, 'function');
      assert.equal(alternative.line, 2);
      assert.equal(typeof alternative.handle, 'string');
    }
    assert.equal(envelope.truncated, true, 'more definitions matched than were followed');
  });

  it('shows at most ten references, the highest ranked', async (t) => {
    const h = await world(t);
    await addParser(h);
    for (let index = 1; index <= 12; index += 1) {
      await addUser(h, `src/use${String(index).padStart(2, '0')}.ts`, '../parser', 'Parser', `use${String(index).padStart(2, '0')}`, 'new');
    }

    const envelope = await h.query({ config: { defaultBudgetTokens: 100000, hardCeilingTokens: 100000 } }).ask(contextRequest(h, { name: 'Parser' }));

    const references = dataOf(envelope).results.filter((item) => item.section === 'reference');
    assert.equal(references.length, 10);
    assert.deepEqual(
      references.map((item) => item.path),
      Array.from({ length: 10 }, (_, index) => `src/use${String(index + 1).padStart(2, '0')}.ts`),
    );
  });

  it('a budget that cuts the list keeps the definition and the highest-priority sections first and continues with a cursor', async (t) => {
    const h = await world(t);
    await addParser(h);
    for (let index = 1; index <= 6; index += 1) {
      await addUser(h, `src/use${String(index)}.ts`, '../parser', 'Parser', `use${String(index)}`, 'new');
    }
    const query = h.query();
    const whole = await query.ask(contextRequest(h, { name: 'Parser', budget_tokens: 100000 }));
    const identity = (item: ContextItem): string => `${item.section}|${item.name}|${item.path}|${String(item.line)}`;

    const pages: Envelope[] = [];
    let more: string | undefined;
    do {
      const page = await query.ask(contextRequest(h, { name: 'Parser', budget_tokens: 700, ...(more === undefined ? {} : { more }) }));
      assert.equal(page.ok, true, JSON.stringify(page.diagnostics));
      pages.push(page);
      more = page.more;
      assert.ok(pages.length <= 30, 'paging must end');
    } while (more !== undefined);

    assert.ok(pages.length > 1, 'the list does not fit in one 700 token page');
    assert.equal(dataOf(pages[0] as Envelope).results[0]?.section, 'definition');
    assert.equal(pages[0]?.truncated, true);
    assert.deepEqual(
      pages.flatMap((page) => dataOf(page).results.map(identity)),
      dataOf(whole).results.map(identity),
    );
    for (const page of pages) assert.ok(estimateTokens(page) <= 700 || dataOf(page).results.length === 1, `page estimate ${String(estimateTokens(page))}`);
  });

  it('a name with no definitions is an ok envelope with an empty list and a hint; a symbol with nothing around it is just its definition', async (t) => {
    const h = await world(t);
    await defineFn(h, 'lonely.ts', 'lonely');

    const none = await h.query().ask(contextRequest(h, { name: 'nothingCalledThis' }));
    const alone = await h.query().ask(contextRequest(h, { name: 'lonely' }));

    assert.equal(none.ok, true, JSON.stringify(none.diagnostics));
    assert.deepEqual(dataOf(none).results, []);
    assert.deepEqual(dataOf(none).alternatives, []);
    assert.equal(none.hints?.length, 1);
    assert.equal(alone.ok, true, JSON.stringify(alone.diagnostics));
    assert.deepEqual(sectionsOf(alone), ['definition', 'export']);
  });

  it('a cursor from code_refs is refused with bad_cursor', async (t) => {
    const h = await world(t);
    await addParser(h);
    for (let index = 1; index <= 3; index += 1) await addCaller(h, `src/c${String(index)}.ts`, '../parser', 'VERSION', `c${String(index)}`);
    const query = h.query();
    const refs = await query.ask({ protocol: 1, kind: 'code_refs', args: { repo: h.dir, name: 'VERSION', limit: 1 }, worktree: h.dir });
    assert.equal(typeof refs.more, 'string');

    const envelope = await query.ask(contextRequest(h, { name: 'VERSION', more: refs.more }));

    assert.equal(envelope.ok, false);
    assert.equal(envelope.diagnostics[0]?.code, 'bad_cursor');
  });
});

describe('code_context: emittedAs (TSM-03)', () => {
  const EMIT: EmitLookup = {
    outputToSource: (p) => (p === 'out/lib.cjs' ? 'src/lib.cts' : undefined),
    sourceToOutputs: (p) => (p === 'src/lib.cts' ? ['out/lib.cjs'] : []),
    isOutput: (p) => p === 'out/lib.cjs',
  };
  const withEmit: ProjectContextProvider = async () => ({ context: { id: 'ts:test', configHashes: [] }, emit: EMIT });
  const LIB = 'export function compute(n) {\n  return n + 1;\n}\n';

  it('emittedAs: names the output of the file that defines the symbol, through the same envelope', async (t) => {
    const h = await createHarness({ projectContext: withEmit });
    t.after(() => h.cleanup());
    await h.addFile('src/lib.cts', LIB, [{ name: 'compute', line: 0, col: 16, exported: true }]);
    await h.addFile('other.ts', 'export function elsewhere() {}\n', [{ name: 'elsewhere', line: 0, col: 16 }]);

    const envelope = await h.query().ask(contextRequest(h, { name: 'compute' }));
    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(dataOf(envelope).file, { path: 'src/lib.cts', emittedAs: ['out/lib.cjs'] });
    assert.equal(dataOf(envelope).results[0]?.section, 'definition', 'the items are unchanged');

    const other = await h.query().ask(contextRequest(h, { name: 'elsewhere' }));
    assert.equal(other.ok, true, JSON.stringify(other.diagnostics));
    assert.ok(!('file' in dataOf(other)), 'a file no config includes has no emittedAs, and not an empty one');
  });

  it('emittedAs is absent, not an empty array, for a store with no project model and for a symbol that is not found', async (t) => {
    const h = await world(t);
    await h.addFile('src/lib.cts', LIB, [{ name: 'compute', line: 0, col: 16, exported: true }]);
    const plain = await h.query().ask(contextRequest(h, { name: 'compute' }));
    assert.equal(plain.ok, true, JSON.stringify(plain.diagnostics));
    assert.ok(!('file' in dataOf(plain)));
    assert.ok(!JSON.stringify(plain.data).includes('emittedAs'));

    const withProject = await createHarness({ projectContext: withEmit });
    t.after(() => withProject.cleanup());
    await withProject.addFile('src/lib.cts', LIB, [{ name: 'compute', line: 0, col: 16, exported: true }]);
    const none =await withProject.query().ask(contextRequest(withProject, { name: 'nothingCalledThis' }));
    assert.equal(none.ok, true, JSON.stringify(none.diagnostics));
    assert.ok(!('file' in dataOf(none)));
  });
});
