import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tomlHeaderLines } from './init-targets.ts';

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
