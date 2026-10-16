/**
 * Fixture builders shared by the code_refs, code_context and code_impact tests (no test inside it). Every file
 * names itself in a comment because the store keys facts by content hash: two files with identical bytes share
 * one set of facts, which would hide the difference these tests plant between them.
 */
import assert from 'node:assert/strict';
import type { Harness } from './harness.test.ts';

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
