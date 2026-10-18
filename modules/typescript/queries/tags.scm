; Definition queries for the typescript module (plan 02-13, LNG-02, D-05). Capture vocabulary: src/grammar-engine/extract.ts.
;
; Scoping rules (the truths of plan 02-13):
; - functions anywhere, including const, let and var bound arrow and function expressions;
; - classes, interfaces, type aliases, enums and namespaces anywhere;
; - methods only in class bodies (constructors excluded) and as interface method signatures;
; - properties only as class fields and interface members (type literal and enum members are not definitions);
; - plain const, let and var only at module top level; destructuring and `require` bindings are not definitions.
;
; Every construct has disjoint patterns so one declaration yields exactly one match:
; - a declaration in `export <declaration>` at module level carries `@export` on the export statement;
; - `export default <declaration>` is defined here WITHOUT `@export` (imports.scm exports it as `default`);
; - everything else is matched by its parent: the program, a block, an ambient declaration or an export inside a block.
; Blocks are separated by blank lines and each block holds one construct.
;
; ADR mentions (plan 03-24, D-19): a comment that mentions an ADR is captured as `@comment`, alone in its match.
; The predicate keeps every other comment on this side of the engine boundary. It is a JavaScript regular expression
; without flags, written with explicit letter classes: a word boundary before ADR (the start of the text or a
; character that is not a letter, digit or underscore), then one of the separators `-`, `#`, ` #` or a space, then a
; digit. It has no nested quantifier, so it runs in linear time. The extractor reads the number and the section
; detail from the text; a string, template or regular expression is not a `comment` node and is never captured.

; --- comment: ADR mention filter ---
((comment) @comment
  (#match? @comment "(^|[^A-Za-z0-9_])[Aa][Dd][Rr](-|#| #| )[0-9]"))

; --- function: declarations, generators and signatures (overloads, ambient) ---
(program
  (export_statement
    declaration: [
      (function_declaration name: (identifier) @name)
      (generator_function_declaration name: (identifier) @name)
      (function_signature name: (identifier) @name)
    ] @definition.function) @export
  (#not-match? @export "^(@[^\\n]*\\s+)*export\\s+default\\b"))

(program
  (export_statement
    declaration: (ambient_declaration
      [
        (function_declaration name: (identifier) @name)
        (function_signature name: (identifier) @name)
      ] @definition.function)) @export)

(program
  (export_statement
    declaration: [
      (function_declaration name: (identifier) @name)
      (generator_function_declaration name: (identifier) @name)
      (function_signature name: (identifier) @name)
    ] @definition.function) @modifier.default
  (#match? @modifier.default "^(@[^\\n]*\\s+)*export\\s+default\\b"))

(program
  [
    (function_declaration name: (identifier) @name)
    (generator_function_declaration name: (identifier) @name)
    (function_signature name: (identifier) @name)
  ] @definition.function)

(statement_block
  [
    (function_declaration name: (identifier) @name)
    (generator_function_declaration name: (identifier) @name)
    (function_signature name: (identifier) @name)
  ] @definition.function)

(statement_block
  (export_statement
    declaration: [
      (function_declaration name: (identifier) @name)
      (generator_function_declaration name: (identifier) @name)
      (function_signature name: (identifier) @name)
    ] @definition.function))

(program
  (ambient_declaration
    [
      (function_declaration name: (identifier) @name)
      (function_signature name: (identifier) @name)
    ] @definition.function))

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

(statement_block
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
    ]))

; --- class: classes and abstract classes ---
(program
  (export_statement
    declaration: [
      (class_declaration name: (type_identifier) @name)
      (abstract_class_declaration name: (type_identifier) @name)
    ] @definition.class) @export
  (#not-match? @export "^(@[^\\n]*\\s+)*export\\s+default\\b"))

(program
  (export_statement
    declaration: (ambient_declaration
      (class_declaration name: (type_identifier) @name) @definition.class)) @export)

(program
  (export_statement
    declaration: [
      (class_declaration name: (type_identifier) @name)
      (abstract_class_declaration name: (type_identifier) @name)
    ] @definition.class) @modifier.default
  (#match? @modifier.default "^(@[^\\n]*\\s+)*export\\s+default\\b"))

(program
  [
    (class_declaration name: (type_identifier) @name)
    (abstract_class_declaration name: (type_identifier) @name)
  ] @definition.class)

(statement_block
  [
    (class_declaration name: (type_identifier) @name)
    (abstract_class_declaration name: (type_identifier) @name)
  ] @definition.class)

(statement_block
  (export_statement
    declaration: [
      (class_declaration name: (type_identifier) @name)
      (abstract_class_declaration name: (type_identifier) @name)
    ] @definition.class))

(program
  (ambient_declaration
    (class_declaration name: (type_identifier) @name) @definition.class))

; --- interface ---
(program
  (export_statement
    declaration: (interface_declaration name: (type_identifier) @name) @definition.interface) @export
  (#not-match? @export "^(@[^\\n]*\\s+)*export\\s+default\\b"))

(program
  (export_statement
    declaration: (interface_declaration name: (type_identifier) @name) @definition.interface) @modifier.default
  (#match? @modifier.default "^(@[^\\n]*\\s+)*export\\s+default\\b"))

(program
  (interface_declaration name: (type_identifier) @name) @definition.interface)

(statement_block
  (interface_declaration name: (type_identifier) @name) @definition.interface)

(statement_block
  (export_statement
    declaration: (interface_declaration name: (type_identifier) @name) @definition.interface))

(program
  (ambient_declaration
    (interface_declaration name: (type_identifier) @name) @definition.interface))

; --- type alias ---
(program
  (export_statement
    declaration: (type_alias_declaration name: (type_identifier) @name) @definition.type) @export)

(program
  (type_alias_declaration name: (type_identifier) @name) @definition.type)

(statement_block
  (type_alias_declaration name: (type_identifier) @name) @definition.type)

(statement_block
  (export_statement
    declaration: (type_alias_declaration name: (type_identifier) @name) @definition.type))

(program
  (ambient_declaration
    (type_alias_declaration name: (type_identifier) @name) @definition.type))

; --- enum: plain, const and declared ---
(program
  (export_statement
    declaration: (enum_declaration name: (identifier) @name) @definition.enum) @export)

(program
  (export_statement
    declaration: (ambient_declaration
      (enum_declaration name: (identifier) @name) @definition.enum)) @export)

(program
  (enum_declaration name: (identifier) @name) @definition.enum)

(statement_block
  (enum_declaration name: (identifier) @name) @definition.enum)

(statement_block
  (export_statement
    declaration: (enum_declaration name: (identifier) @name) @definition.enum))

(program
  (ambient_declaration
    (enum_declaration name: (identifier) @name) @definition.enum))

; --- namespace: a namespace is an expression statement in this grammar ---
(program
  (export_statement
    declaration: (internal_module name: (identifier) @name) @definition.namespace) @export)

(program
  (export_statement
    declaration: (ambient_declaration
      (internal_module name: (identifier) @name) @definition.namespace)) @export)

(expression_statement
  (internal_module name: (identifier) @name) @definition.namespace)

(statement_block
  (export_statement
    declaration: (internal_module name: (identifier) @name) @definition.namespace))

(program
  (ambient_declaration
    (internal_module name: (identifier) @name) @definition.namespace))

; --- const at module top level (a function-valued or require() value is not a plain const) ---
(program
  (export_statement
    declaration: [
      (lexical_declaration "const"
        [
          (variable_declarator name: (identifier) @name value: (_ !body) @value.plain) @definition.constant
          (variable_declarator name: (identifier) @name !value) @definition.constant
        ])
      (ambient_declaration
        (lexical_declaration "const"
          (variable_declarator name: (identifier) @name !value) @definition.constant))
    ]) @export
  (#not-match? @value.plain "^require\\s*\\("))

(program
  [
    (lexical_declaration "const"
      [
        (variable_declarator name: (identifier) @name value: (_ !body) @value.plain) @definition.constant
        (variable_declarator name: (identifier) @name !value) @definition.constant
      ])
    (ambient_declaration
      (lexical_declaration "const"
        (variable_declarator name: (identifier) @name !value) @definition.constant))
  ]
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

; --- method: class methods, accessors, overload and abstract signatures; interface method signatures ---
(class_body
  [
    (method_definition name: [(property_identifier) (private_property_identifier)] @name)
    (method_signature name: [(property_identifier) (private_property_identifier)] @name)
    (abstract_method_signature name: [(property_identifier) (private_property_identifier)] @name)
  ] @definition.method
  (#not-eq? @name "constructor"))

(interface_body
  (method_signature name: (property_identifier) @name) @definition.method)

; --- property: class fields and interface members ---
(class_body
  (public_field_definition name: [(property_identifier) (private_property_identifier)] @name) @definition.property)

(interface_body
  (property_signature name: (property_identifier) @name) @definition.property)
