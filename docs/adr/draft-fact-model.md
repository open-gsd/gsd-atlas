# ADR: Fact model, provenance and identity

- **Status:** Proposed
- **Issue:** to be opened (rename to `<issue#>-fact-model.md`)
- **DESIGN.md:** A2, A8, A19, A45
- **Review findings addressed:** F‑1, F‑2, F‑3, F‑4, F‑5, F‑6

## Context
Every answer gsd‑atlas gives must be citable to a file and line, correct for the branch or worktree the agent is in, interoperable with gsd‑graph, and honest about how certain it is. The store needs a content identity that dedupes across branches and lets any past version be rebuilt from git.

The design review found that an earlier draft keyed *all* facts by file content. That is wrong for resolved references: what `foo()` calls depends on the other files, the config and the dependencies in that worktree, so identical file content can resolve differently on two branches. The draft also derived symbol ids from the file's content hash, so every edit renamed every symbol in the file.

## Decision
1. **Two layers of facts.**
   - **Local facts** come from one file alone: definitions, containment, imports as written, and reference sites (the name and import path as written at a span). They are keyed by the file's content hash and shared across every branch and worktree that has that content.
   - **Resolved edges** bind a reference site to its target definition. They are keyed by (overlay snapshot hash, resolution context id), where the resolution context hashes the module's config files (e.g. tsconfig chain, `Package.swift`) and the dependency lockfile. They are computed lazily per overlay and cached; overlays with the same snapshot and context share them.
2. **Fixed vocabulary per release:** `defines`, `contains`, `imports`, `reexports`, `calls`, `references`, `extends`, `extension_of`, `implements`, `conforms_to`, `overrides`, `tested_by`, `emitted_as`, `cites_adr`, `uses_sdk_symbol`, `targets_platform`. \1 The vocabulary is a logical enum; storage is typed tables, and availability is data on SDK symbols, not predicates.
3. **Provenance in gsd‑graph's shape** on every fact: `source_path`, `span` (start and end line, **mandatory**), `extractor`, `content_hash`, `first_seen`, `last_seen`, `confidence`, plus a `debug` handle for `gsd-atlas explain`.
4. **Confidence tiers** use gsd‑graph's names and rank order. Local definitions and imports are `EXTRACTED`. Grammar‑tier resolution by name is `INFERRED`. Compiler or SCIP resolution is `EXTRACTED` and supersedes an `INFERRED` edge at the same reference site.
5. **Content hash = git blob id** computed with the same clean filters git applies (`git hash-object --path`), for tracked, modified and untracked files. The line‑ending mode is recorded so spans match the working tree. Git LFS pointer files are skipped with a diagnostic.
6. **Stable symbol identity** = (repo, path, qualified name, kind, overload discriminator). The content hash is the symbol's *version*, not part of its identity. Edges and agent ledgers point at identities. A rename or move is a remove plus an add, with a `renamed_from` hint when signatures match.
7. **`tested_by`** is derived from per‑module test globs (in the module manifest) plus references from those files; always `INFERRED`.
8. **ADR citations** resolve ADR ids against the repo's ADR directory. When an id maps to several files (gsd‑core has legacy duplicates such as `0010` and `0011`), `cites_adr` points at every candidate with `INFERRED` confidence and the ambiguity is reported.

## Consequences
- Answers are correct for the overlay asked about; local facts still dedupe across branches. gsd‑path's 553 Python files have only 230 distinct contents (measured 2026‑10‑15), so 230 are parsed.
- Resolved edges cost a lazy computation per new snapshot; the cache makes repeat queries cheap, and identical worktrees share it.
- Editing a file changes only its symbols' versions; other files' edges and agents' ledgers keep pointing at the same identities.
- `git ls-files -s` gives a cheap drift check; LFS and CRLF can't corrupt spans.
- A module that can't produce spans can't ship.

## Alternatives considered
- **All facts keyed by file content (earlier draft):** wrong answers across branches.
- **Resolve everything eagerly per overlay:** correct, but hundreds of short‑lived worktrees would each pay full resolution up front.
- **SHA‑256 of raw content:** no link to git objects; breaks history replay.
- **Symbol id from content hash:** every edit breaks inbound references.
- **Optional spans (gsd‑graph 0.1 PRD):** citations to file:line are a core requirement.
