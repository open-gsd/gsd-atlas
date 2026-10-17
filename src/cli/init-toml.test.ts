import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tomlHeaderKey, tomlHeaderLines, tomlStatements } from './init-targets.ts';

/** The zero-based indexes of the real table headers in `lines`, in order. */
function headers(...lines: string[]): number[] {
  return [...tomlHeaderLines(lines)].sort((a, b) => a - b);
}

describe('tomlHeaderLines: which lines are real table headers', () => {
  it('finds plain headers, with leading blanks and a trailing comment', () => {
    assert.deepEqual(headers('a = 1', '[t]', 'b = 2', '  [u] # note', '\t[v]', 'c = 3'), [1, 3, 4]);
  });

  it('array of tables: [[x]] is one header and leaves no bracket depth behind', () => {
    assert.deepEqual(headers('[[x]]', 'a = 1', '[[x]]', 'b = [1, 2]', '[y]'), [0, 2, 4]);
  });

  it('quoted key with bracket: a header whose quoted key holds ] is one header, and a key line holding [ is not', () => {
    assert.deepEqual(headers('["a]b".c]', 'k = 1', "['x]y']", '"w[" = 1', '[z]'), [0, 2, 4]);
    assert.deepEqual(headers('a."b]" = [1]', '[t]'), [1]);
    assert.deepEqual(headers('k = ["]", "["]', '[t]'), [1]);
  });

  it('multi-line array: a continuation line that starts with [ is not a header', () => {
    assert.deepEqual(headers('notes = [', '  [1, 2],', '  [3]', ']', '[next]'), [4]);
    assert.deepEqual(headers('notes = [', '[', '  1,', '],', ']', '[next]'), [5]);
  });

  it('multi-line array: brackets in a trailing comment inside the array do not move the depth', () => {
    assert.deepEqual(headers('k = [ # [', '  1,', ']', '[t]'), [3]);
  });

  it('inline table spanning lines: its inner array lines are not headers', () => {
    assert.deepEqual(headers('t = {', '  x = [', '[1], [2]', '  ]', '}', '[next]'), [5]);
  });

  it('multi-line basic string: its lines are never headers, escapes and same-line closes are honoured', () => {
    assert.deepEqual(headers('k = """', '[not a table]', '"""', '[t]'), [3]);
    assert.deepEqual(headers('k = """one line"""', '[t]'), [1]);
    assert.deepEqual(headers('k = """', 'has \\""" inside', '[still not]', '"""', '[t]'), [4]);
    assert.deepEqual(headers('k = """', 'ends with four quotes""""', '[t]'), [2]);
    assert.deepEqual(headers('k = "a\\"[b"', '[t]'), [1]);
  });

  it('multi-line literal string: its lines are never headers and a backslash escapes nothing', () => {
    assert.deepEqual(headers("k = '''", '[not a table]', "'''", '[t]'), [3]);
    assert.deepEqual(headers("k = '''", 'ends with a backslash \\', '[x]', "'''", '[t]'), [4]);
    assert.deepEqual(headers("k = '''one line'''", '[t]'), [1]);
  });

  it('comment line: a comment that starts with [ or holds quotes opens nothing', () => {
    assert.deepEqual(headers('# [fake]', '  # [also]', '[t]', '# """', "# '''", '[u]'), [2, 5]);
  });

  it('strings holding #: the # does not start a comment, so the array depth is still tracked', () => {
    assert.deepEqual(headers('k = ["#",', '[1],', ']', '[t]'), [3]);
    assert.deepEqual(headers("k = '#'", '[t]'), [1]);
  });

  it('an unclosed header is still a header line (the caller refuses it)', () => {
    assert.deepEqual(headers('a = 1', '[broken', 'b = 2'), [1]);
  });
});

describe('tomlHeaderKey: the key path of a table header, however it is spelled', () => {
  it('plain, spaced, commented and quoted spellings give the same parts', () => {
    const wanted = ['mcp_servers', 'gsd-atlas'];
    for (const line of [
      '[mcp_servers.gsd-atlas]',
      '[mcp_servers.gsd-atlas] # note',
      '  [ mcp_servers.gsd-atlas ]',
      '[mcp_servers . gsd-atlas]',
      '[mcp_servers."gsd-atlas"]',
      "[mcp_servers.'gsd-atlas']",
      '["mcp_servers"."gsd-atlas"]',
      '["mcp_servers".\'gsd-atlas\'] # c',
    ]) {
      assert.deepEqual(tomlHeaderKey(line), { parts: wanted, array: false }, line);
    }
  });

  it('a quoted part keeps its dots and brackets, and its escapes are decoded', () => {
    assert.deepEqual(tomlHeaderKey('["a.b".c]'), { parts: ['a.b', 'c'], array: false });
    assert.deepEqual(tomlHeaderKey('["a]b"]'), { parts: ['a]b'], array: false });
    assert.deepEqual(tomlHeaderKey('["gsd\\u002datlas"]'), { parts: ['gsd-atlas'], array: false });
    assert.deepEqual(tomlHeaderKey('["q\\"x"]'), { parts: ['q"x'], array: false });
  });

  it('an array of tables is reported as such', () => {
    assert.deepEqual(tomlHeaderKey('[[mcp_servers.gsd-atlas]]'), { parts: ['mcp_servers', 'gsd-atlas'], array: true });
  });

  it('text that is not a closed header with a valid key gives null', () => {
    for (const line of ['[broken', '[]', '[a..b]', '[a.]', '[a b]', '[a] trailing', 'key = 1', '[[a]', '[a"b]']) {
      assert.equal(tomlHeaderKey(line), null, line);
    }
  });
});

describe('tomlStatements: the key statements of one table body, with their full line spans', () => {
  it('finds single-line statements with their key parts and skips blanks and comment lines', () => {
    const lines = ['', '# note', 'a = 1', '  b.c = 2 # x', '"d e" = 3', '', "'f'.g = 4"];
    assert.deepEqual(tomlStatements(lines, 0, lines.length), [
      { start: 2, end: 2, key: ['a'] },
      { start: 3, end: 3, key: ['b', 'c'] },
      { start: 4, end: 4, key: ['d e'] },
      { start: 6, end: 6, key: ['f', 'g'] },
    ]);
  });

  it('a multi-line array, inline table or string is one statement, and its inner lines are not statements', () => {
    const lines = ['args = [', '  "x", # inner', '  [1],', ']', 'doc = """', 'k = 1', '"""', 't = {', '  u = 1,', '}', 'last = 0'];
    assert.deepEqual(tomlStatements(lines, 0, lines.length), [
      { start: 0, end: 3, key: ['args'] },
      { start: 4, end: 6, key: ['doc'] },
      { start: 7, end: 9, key: ['t'] },
      { start: 10, end: 10, key: ['last'] },
    ]);
  });

  it('only the lines from..to are scanned, and a statement whose key cannot be parsed has a null key', () => {
    const lines = ['x = 1', 'y = 2', '= 3', 'z = 4'];
    assert.deepEqual(tomlStatements(lines, 1, 3), [
      { start: 1, end: 1, key: ['y'] },
      { start: 2, end: 2, key: null },
    ]);
  });

  it('a CR at the end of a line is ignored', () => {
    assert.deepEqual(tomlStatements(['a = 1\r', 'b = [\r', '  1,\r', ']\r'], 0, 4), [
      { start: 0, end: 0, key: ['a'] },
      { start: 1, end: 3, key: ['b'] },
    ]);
  });
});
