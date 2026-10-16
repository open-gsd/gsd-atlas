; Definitions of the toy language: `fn` and `type` blocks.
(definition
  kind: "fn"
  name: (identifier) @name) @definition.function

(definition
  kind: "type"
  name: (identifier) @name) @definition.type
