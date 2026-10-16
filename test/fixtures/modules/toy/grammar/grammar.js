/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// The toy language: a tiny purpose-built grammar this repo owns (D-01). It is the first
// language module the Phase 1 engine loads and, later, Phase 2's second non-TypeScript
// fixture language. Node and field names here are depended on by the queries and goldens:
//   source_file, use_stmt (path), definition (kind, name), call_stmt (target),
//   identifier, string, comment.

module.exports = grammar({
  name: 'atlas_toy',

  word: ($) => $.identifier,

  extras: ($) => [/\s/, $.comment],

  rules: {
    source_file: ($) => repeat($._item),

    _item: ($) => choice($.use_stmt, $.definition, $.call_stmt),

    use_stmt: ($) => seq('use', field('path', $.string), ';'),

    definition: ($) =>
      seq(
        field('kind', choice('fn', 'type')),
        field('name', $.identifier),
        '{',
        repeat($._item),
        '}',
      ),

    call_stmt: ($) => seq(field('target', $.identifier), '(', ')', ';'),

    identifier: ($) => /[\p{L}_][\p{L}\p{N}_]*/,

    string: ($) => /"[^"\n]*"/,

    comment: ($) => token(seq('#', /[^\n]*/)),
  },
});
