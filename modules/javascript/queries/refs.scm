; Reference sites for the javascript module (plan 02-13, D-06). Capture vocabulary: src/grammar-engine/extract.ts.
; The extractor keeps a site only when its name is a top-level definition, an import binding or an export name of the
; same file (or the property of a member call), and never a declaration's own name, so these patterns may be broad.
; Every identifier position is covered by exactly one pattern, so a site has one kind. JavaScript has no type
; positions, so there is no type reference here.

; --- calls, constructions and member calls ---
(call_expression
  function: (identifier) @reference.call)

(new_expression
  constructor: (identifier) @reference.new)

(call_expression
  function: (member_expression
    property: (property_identifier) @reference.member))

; --- heritage: class extends ---
(class_heritage
  (identifier) @reference.heritage)

; --- reads: an identifier in an expression position ---
(arguments (identifier) @reference.read)
(array (identifier) @reference.read)
(pair value: (identifier) @reference.read)
(spread_element (identifier) @reference.read)
(parenthesized_expression (identifier) @reference.read)
(template_substitution (identifier) @reference.read)
(expression_statement (identifier) @reference.read)
(return_statement (identifier) @reference.read)
(throw_statement (identifier) @reference.read)
(yield_expression (identifier) @reference.read)
(await_expression (identifier) @reference.read)
(unary_expression argument: (identifier) @reference.read)
(sequence_expression (identifier) @reference.read)
(binary_expression left: (identifier) @reference.read)
(binary_expression right: (identifier) @reference.read)
(assignment_expression right: (identifier) @reference.read)
(augmented_assignment_expression right: (identifier) @reference.read)
(variable_declarator value: (identifier) @reference.read)
(arrow_function body: (identifier) @reference.read)
(ternary_expression condition: (identifier) @reference.read)
(ternary_expression consequence: (identifier) @reference.read)
(ternary_expression alternative: (identifier) @reference.read)
(member_expression object: (identifier) @reference.read)
(subscript_expression object: (identifier) @reference.read)
(subscript_expression index: (identifier) @reference.read)
(for_in_statement right: (identifier) @reference.read)
(shorthand_property_identifier) @reference.read
