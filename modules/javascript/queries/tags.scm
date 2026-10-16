; Tracer query (plan 02-08): function, class and function-valued const definitions. Plan 02-13 expands this to every construct.
(function_declaration
  name: (identifier) @name) @definition.function

(class_declaration
  name: (identifier) @name) @definition.class

(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.function
