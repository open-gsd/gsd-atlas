; Imports and exports for the typescript module (plan 02-13, LNG-02, D-05). Capture vocabulary: src/grammar-engine/extract.ts.
; The extractor merges the matches that share a statement span into one import site, so a statement with several
; bindings is written as one pattern per binding. The `cjs.*` and `require.callee` captures only feed predicates.
; Exported declarations (`export function f`) are not here: tags.scm marks them with `@export`.

; --- ES imports ---
(import_statement
  (import_clause (identifier) @import.default)
  source: (string) @import.path) @import.es

(import_statement
  (import_clause (namespace_import (identifier) @import.namespace))
  source: (string) @import.path) @import.es

(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import.named
        alias: (identifier)? @import.local)))
  source: (string) @import.path) @import.es

; import "./side-effect": the source is the first named child, there is no import clause
(import_statement
  . source: (string) @import.path) @import.side-effect

; --- import x = require("./path"): the TypeScript CommonJS import ---
(import_statement
  (import_require_clause
    (identifier) @import.namespace
    source: (string) @import.path)) @import.cjs

; --- CommonJS require calls: every call, then the binding forms that share its span ---
(call_expression
  function: (identifier) @require.callee
  arguments: (arguments . (string) @import.path)
  (#eq? @require.callee "require")) @import.cjs

(variable_declarator
  name: (identifier) @import.namespace
  value: (call_expression
    function: (identifier) @require.callee
    arguments: (arguments . (string) @import.path)) @import.cjs
  (#eq? @require.callee "require"))

(variable_declarator
  name: (object_pattern
    [
      (shorthand_property_identifier_pattern) @import.named
      (pair_pattern
        key: (property_identifier) @import.named
        value: (identifier) @import.local)
    ])
  value: (call_expression
    function: (identifier) @require.callee
    arguments: (arguments . (string) @import.path)) @import.cjs
  (#eq? @require.callee "require"))

(variable_declarator
  name: (identifier) @import.local
  value: (member_expression
    object: (call_expression
      function: (identifier) @require.callee
      arguments: (arguments . (string) @import.path)) @import.cjs
    property: (property_identifier) @import.named)
  (#eq? @require.callee "require"))

; --- ES re-exports: the statement is both an export and a re-export import ---
(export_statement
  "*" @export.name
  source: (string) @export.from @import.path) @export @import.reexport

(export_statement
  (namespace_export (identifier) @export.name)
  source: (string) @export.from @import.path) @export @import.reexport

(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @export.local
      alias: (identifier) @export.name))
  source: (string) @export.from @import.path) @export @import.reexport

(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @export.name
      !alias))
  source: (string) @export.from @import.path) @export @import.reexport

; --- ES exports of local names: export { a, b as c } ---
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @export.local
      alias: (identifier) @export.name))
  !source) @export

(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @export.name
      !alias))
  !source) @export

; --- export default: the name other files import is `default` ---
(export_statement
  "default" @export.name
  declaration: [
    (function_declaration name: (identifier) @export.local)
    (generator_function_declaration name: (identifier) @export.local)
    (function_signature name: (identifier) @export.local)
    (class_declaration name: (type_identifier) @export.local)
    (abstract_class_declaration name: (type_identifier) @export.local)
    (interface_declaration name: (type_identifier) @export.local)
  ]) @export

(export_statement
  "default" @export.name
  value: (identifier) @export.local) @export

(export_statement
  "default" @export.name
  value: (_) @export.value
  (#not-match? @export.value "^[A-Za-z_$][\\w$]*$")) @export

; --- CommonJS exports: module.exports = x, one site per property of an object literal ---
(assignment_expression
  left: (member_expression
    object: (identifier) @cjs.object
    property: (property_identifier) @cjs.property) @export.name
  right: (identifier) @export.local
  (#eq? @cjs.object "module")
  (#eq? @cjs.property "exports")) @export

(assignment_expression
  left: (member_expression
    object: (identifier) @cjs.object
    property: (property_identifier) @cjs.property) @export.name
  right: (_) @cjs.value
  (#eq? @cjs.object "module")
  (#eq? @cjs.property "exports")
  (#not-match? @cjs.value "^(\\{|[A-Za-z_$][\\w$]*$)")) @export

(assignment_expression
  left: (member_expression
    object: (identifier) @cjs.object
    property: (property_identifier) @cjs.property)
  right: (object
    [
      (shorthand_property_identifier) @export.name
      (pair
        key: (property_identifier) @export.name
        value: (identifier) @export.local)
      (method_definition name: (property_identifier) @export.name)
    ])
  (#eq? @cjs.object "module")
  (#eq? @cjs.property "exports")) @export

(assignment_expression
  left: (member_expression
    object: (identifier) @cjs.object
    property: (property_identifier) @cjs.property)
  right: (object
    (pair
      key: (property_identifier) @export.name
      value: (_) @cjs.value))
  (#eq? @cjs.object "module")
  (#eq? @cjs.property "exports")
  (#not-match? @cjs.value "^[A-Za-z_$][\\w$]*$")) @export

; --- CommonJS exports: exports.name = x ---
(assignment_expression
  left: (member_expression
    object: (identifier) @cjs.object
    property: (property_identifier) @export.name)
  right: (identifier) @export.local
  (#eq? @cjs.object "exports")) @export

(assignment_expression
  left: (member_expression
    object: (identifier) @cjs.object
    property: (property_identifier) @export.name)
  right: (_) @cjs.value
  (#eq? @cjs.object "exports")
  (#not-match? @cjs.value "^[A-Za-z_$][\\w$]*$")) @export

; --- CommonJS exports: module.exports.name = x ---
(assignment_expression
  left: (member_expression
    object: (member_expression
      object: (identifier) @cjs.object
      property: (property_identifier) @cjs.property)
    property: (property_identifier) @export.name)
  right: (identifier) @export.local
  (#eq? @cjs.object "module")
  (#eq? @cjs.property "exports")) @export

(assignment_expression
  left: (member_expression
    object: (member_expression
      object: (identifier) @cjs.object
      property: (property_identifier) @cjs.property)
    property: (property_identifier) @export.name)
  right: (_) @cjs.value
  (#eq? @cjs.object "module")
  (#eq? @cjs.property "exports")
  (#not-match? @cjs.value "^[A-Za-z_$][\\w$]*$")) @export
