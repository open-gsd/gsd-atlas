/**
 * Fixture builders shared by the code_refs, code_context and code_impact tests (no test inside it). Every file
 * names itself in a comment because the store keys facts by content hash: two files with identical bytes share
 * one set of facts, which would hide the difference these tests plant between them.
 */
import assert from 'node:assert/strict';
import type { Resolver } from '../fact-store/index.ts';
import type { SymbolIdentity } from '../facts/index.ts';
import type { ScriptedRelation } from '../precise-resolver/index.ts';
import type { FactsSpec, Harness, ImportSpec, RefSpec, SymbolSpec } from './harness.test.ts';

/** The 0-based line and column where `needle` first appears in `content` at or after `after`. */
export function where(content: string, needle: string, after = 0): { line: number; col: number } {
  const index = content.indexOf(needle, after);
  assert.ok(index >= 0, `${needle} appears in the fixture`);
  const before = content.slice(0, index).split('\n');
  return { line: before.length - 1, col: (before[before.length - 1] ?? '').length };
}

/** Where the name of `function NAME(` starts. */
export function nameOf(content: string, name: string): { line: number; col: number } {
  const at = where(content, `function ${name}(`);
  return { line: at.line, col: at.col + 'function '.length };
}

/** `export function NAME() {}` on line 1 (below a path comment), exported under its own name. */
export async function defineFn(h: Harness, file: string, name: string, extra: { kind?: string } = {}): Promise<void> {
  const content = `// ${file}\nexport function ${name}() {}\n`;
  const at = nameOf(content, name);
  await h.addFileWith(file, content, {
    symbols: [{ name, kind: extra.kind ?? 'function', line: at.line, col: at.col, exported: true }],
    exports: [{ name, line: at.line, col: at.col }],
  });
}

/** A file that imports `name` from `from` and calls it inside the exported function `fn`. Returns the file text. */
export async function addCaller(h: Harness, file: string, from: string, name: string, fn: string): Promise<string> {
  const content = `// ${file}\nimport { ${name} } from '${from}';\nexport function ${fn}() { return ${name}(1); }\n`;
  const decl = nameOf(content, fn);
  const call = where(content, `${name}(1)`);
  await h.addFileWith(file, content, {
    symbols: [{ name: fn, kind: 'function', line: decl.line, col: decl.col, exported: true }],
    refs: [{ name, line: call.line, col: call.col, kind: 'call', enclosing: 0 }],
    imports: [{ path: from, line: 1, style: 'es', bindings: [{ imported: name, local: name }] }],
    exports: [{ name: fn, line: decl.line, col: decl.col }],
  });
  return content;
}

// ---------------------------------------------------------------------------------------------------------
// Plan 03-25: a small class hierarchy for extends, implements and overrides.
// ---------------------------------------------------------------------------------------------------------

/** The files of the shapes world: an interface, an abstract class, two subclasses, an interface extension and a class that extends a library class. */
export const SHAPE_TEXT = {
  'shape.ts': '// shape.ts\nexport interface Shape { area(): number; }\n',
  'base.ts':
    "// base.ts\nimport { Shape } from './shape';\nexport abstract class Base implements Shape {\n  abstract area(): number;\n  name(): string { return 'base'; }\n}\n",
  'sub.ts':
    "// sub.ts\nimport { Base } from './base';\nexport class Sub extends Base {\n  area(): number { return 1; }\n  name(): string { return 'sub'; }\n}\n",
  'box.ts': "// box.ts\nimport { Base } from './base';\nexport class Box extends Base {}\n",
  'square.ts': "// square.ts\nimport { Shape } from './shape';\nexport interface Square extends Shape {}\n",
  'boom.ts': '// boom.ts\nexport class Boom extends Error {}\n',
} as const;

export type ShapeFile = keyof typeof SHAPE_TEXT;

/** The 0-based line and column of `needle` in a shapes file, moved right by `skip` columns. */
export function shapeAt(file: ShapeFile, needle: string, skip = 0): { line: number; col: number } {
  const found = where(SHAPE_TEXT[file], needle);
  return { line: found.line, col: found.col + skip };
}

/** The identity of a symbol of the shapes world, as the harness store (repo `toy`) names it. */
export const toyId = (filePath: string, qualifiedName: string, kind = 'class'): SymbolIdentity => ({ repo: 'toy', path: filePath, qualifiedName, kind });

export const SHAPES = {
  shape: toyId('shape.ts', 'Shape', 'interface'),
  shapeArea: toyId('shape.ts', 'Shape.area', 'method'),
  base: toyId('base.ts', 'Base'),
  baseArea: toyId('base.ts', 'Base.area', 'method'),
  baseName: toyId('base.ts', 'Base.name', 'method'),
  sub: toyId('sub.ts', 'Sub'),
  subArea: toyId('sub.ts', 'Sub.area', 'method'),
  subName: toyId('sub.ts', 'Sub.name', 'method'),
  box: toyId('box.ts', 'Box'),
  square: toyId('square.ts', 'Square', 'interface'),
  boom: toyId('boom.ts', 'Boom'),
} as const;

/** What the compiler says about the shapes world; `Boom extends Error` is absent because its base is not in the repository. */
export const SHAPE_RELATIONS: readonly ScriptedRelation[] = [
  { from: SHAPES.sub, to: SHAPES.base, relation: 'extends' },
  { from: SHAPES.box, to: SHAPES.base, relation: 'extends' },
  { from: SHAPES.square, to: SHAPES.shape, relation: 'extends' },
  { from: SHAPES.base, to: SHAPES.shape, relation: 'implements' },
  { from: SHAPES.subArea, to: SHAPES.baseArea, relation: 'overrides' },
  { from: SHAPES.subName, to: SHAPES.baseName, relation: 'overrides' },
];

/** Store the shapes world: the files on disk and their facts, with the heritage sites the grammar tier reports. */
export async function addShapes(h: Harness): Promise<void> {
  const put = (file: ShapeFile, spec: FactsSpec): Promise<string> => h.addFileWith(file, SHAPE_TEXT[file], spec);
  const top = (file: ShapeFile, needle: string, name: string, kind: string): SymbolSpec => ({ name, kind, ...shapeAt(file, needle), exported: true });
  const member = (file: ShapeFile, needle: string, name: string, qualifiedName: string): SymbolSpec => ({
    name,
    kind: 'method',
    qualifiedName,
    parent: 0,
    ...shapeAt(file, needle),
  });
  const heritage = (file: ShapeFile, needle: string, name: string): RefSpec => ({
    name,
    ...shapeAt(file, needle, needle.indexOf(' ') + 1),
    kind: 'heritage',
    enclosing: 0,
  });
  const importOf = (from: string, name: string): ImportSpec => ({ path: from, line: 1, style: 'es', bindings: [{ imported: name, local: name }] });
  await put('shape.ts', { symbols: [top('shape.ts', 'Shape', 'Shape', 'interface'), member('shape.ts', 'area', 'area', 'Shape.area')] });
  await put('base.ts', {
    symbols: [top('base.ts', 'Base', 'Base', 'class'), member('base.ts', 'area', 'area', 'Base.area'), member('base.ts', 'name', 'name', 'Base.name')],
    refs: [heritage('base.ts', 'implements Shape', 'Shape')],
    imports: [importOf('./shape', 'Shape')],
  });
  await put('sub.ts', {
    symbols: [top('sub.ts', 'Sub', 'Sub', 'class'), member('sub.ts', 'area', 'area', 'Sub.area'), member('sub.ts', 'name', 'name', 'Sub.name')],
    refs: [heritage('sub.ts', 'extends Base', 'Base')],
    imports: [importOf('./base', 'Base')],
  });
  await put('box.ts', {
    symbols: [top('box.ts', 'Box', 'Box', 'class')],
    refs: [heritage('box.ts', 'extends Base', 'Base')],
    imports: [importOf('./base', 'Base')],
  });
  await put('square.ts', {
    symbols: [top('square.ts', 'Square', 'Square', 'interface')],
    refs: [heritage('square.ts', 'extends Shape', 'Shape')],
    imports: [importOf('./shape', 'Shape')],
  });
  await put('boom.ts', { symbols: [top('boom.ts', 'Boom', 'Boom', 'class')], refs: [heritage('boom.ts', 'extends Error', 'Error')] });
}

/** What a scripted resolver in the shapes world was asked, for counting calls. */
export interface RelationSpy {
  /** The files each `relations` call named, in call order. */
  readonly calls: string[][];
}

/**
 * A store resolver that has no edges and the given scripted relations: a `relations` call yields the ones whose `from` is
 * declared in one of the files asked. `before` runs first in each call (a test makes it wait or throw).
 */
export function relationResolver(
  relations: readonly ScriptedRelation[],
  options: { readonly before?: () => Promise<void> } = {},
): { readonly resolver: Resolver; readonly spy: RelationSpy } {
  const spy: RelationSpy = { calls: [] };
  const port: Resolver = async function* () {
    // no edges: only relations
  };
  const resolver: Resolver = Object.assign(port, {
    relations: async function* (files: readonly string[]) {
      spy.calls.push([...files]);
      await options.before?.();
      for (const relation of relations) {
        if (files.includes(relation.from.path)) yield { ...relation, resolver: 'scripted' };
      }
    },
  });
  return { resolver, spy };
}
