; Definition queries for the javascript module (plan 02-13, LNG-02, D-05). Capture vocabulary: src/grammar-engine/extract.ts.
;
; Scoping rules (the truths of plan 02-13):
; - functions anywhere, including const, let and var bound arrow and function expressions;
; - classes anywhere;
; - methods only in class bodies (constructors excluded); properties only as class fields;
; - plain const, let and var only at module top level; destructuring and `require` bindings are not definitions
;   (a require() binding is an import, see imports.scm).
;
; Every construct has disjoint patterns so one declaration yields exactly one match:
; - a declaration in `export <declaration>` carries `@export` on the export statement;
; - `export default <declaration>` is defined here WITHOUT `@export` (imports.scm exports it as `default`);
; - everything else is matched by its parent: the program or a block.
; Blocks are separated by blank lines and each block holds one construct.

; --- function: declarations and generators ---
(program
  (export_statement
    declaration: [
      (function_declaration name: (identifier) @name)
      (generator_function_declaration name: (identifier) @name)
    ] @definition.function) @export
  (#not-match? @export "^export\\s+default\\b"))

(program
  (export_statement
    declaration: [
      (function_declaration name: (identifier) @name)
      (generator_function_declaration name: (identifier) @name)
    ] @definition.function) @modifier.default
  (#match? @modifier.default "^export\\s+default\\b"))

(program
  [
    (function_declaration name: (identifier) @name)
    (generator_function_declaration name: (identifier) @name)
  ] @definition.function)

(statement_block
  [
    (function_declaration name: (identifier) @name)
    (generator_function_declaration name: (identifier) @name)
  ] @definition.function)

; --- function: const, let and var bound arrow and function expressions ---
(program
  (export_statement
    declaration: [
      (lexical_declaration
        (variable_declarator
          name: (identifier) @name
          value: [(arrow_function) (function_expression)]) @definition.function)
      (variable_declaration
        (variable_declarator
          name: (identifier) @name
          value: [(arrow_function) (function_expression)]) @definition.function)
    ]) @export)

(program
  [
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression)]) @definition.function)
    (variable_declaration
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression)]) @definition.function)
  ])

(statement_block
  [
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression)]) @definition.function)
    (variable_declaration
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression)]) @definition.function)
  ])

; --- class ---
(program
  (export_statement
    declaration: (class_declaration name: (identifier) @name) @definition.class) @export
  (#not-match? @export "^export\\s+default\\b"))

(program
  (export_statement
    declaration: (class_declaration name: (identifier) @name) @definition.class) @modifier.default
  (#match? @modifier.default "^export\\s+default\\b"))

(program
  (class_declaration name: (identifier) @name) @definition.class)

(statement_block
  (class_declaration name: (identifier) @name) @definition.class)

; --- const at module top level (a function-valued or require() value is not a plain const) ---
(program
  (export_statement
    declaration: (lexical_declaration "const"
      [
        (variable_declarator name: (identifier) @name value: (_ !body) @value.plain) @definition.constant
        (variable_declarator name: (identifier) @name !value) @definition.constant
      ])) @export
  (#not-match? @value.plain "^require\\s*\\("))

(program
  (lexical_declaration "const"
    [
      (variable_declarator name: (identifier) @name value: (_ !body) @value.plain) @definition.constant
      (variable_declarator name: (identifier) @name !value) @definition.constant
    ])
  (#not-match? @value.plain "^require\\s*\\("))

; --- let and var at module top level ---
(program
  (export_statement
    declaration: [
      (lexical_declaration "let"
        [
          (variable_declarator name: (identifier) @name value: (_ !body) @value.plain) @definition.variable
          (variable_declarator name: (identifier) @name !value) @definition.variable
        ])
      (variable_declaration
        [
          (variable_declarator name: (identifier) @name value: (_ !body) @value.plain) @definition.variable
          (variable_declarator name: (identifier) @name !value) @definition.variable
        ])
    ]) @export
  (#not-match? @value.plain "^require\\s*\\("))

(program
  [
    (lexical_declaration "let"
      [
        (variable_declarator name: (identifier) @name value: (_ !body) @value.plain) @definition.variable
        (variable_declarator name: (identifier) @name !value) @definition.variable
      ])
    (variable_declaration
      [
        (variable_declarator name: (identifier) @name value: (_ !body) @value.plain) @definition.variable
        (variable_declarator name: (identifier) @name !value) @definition.variable
      ])
  ]
  (#not-match? @value.plain "^require\\s*\\("))

; --- method: class methods and accessors ---
(class_body
  (method_definition name: [(property_identifier) (private_property_identifier)] @name) @definition.method
  (#not-eq? @name "constructor"))

; --- property: class fields ---
(class_body
  (field_definition property: [(property_identifier) (private_property_identifier)] @name) @definition.property)
