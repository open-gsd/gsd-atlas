# ADR: Fact model, provenance and identity

- **Status:** Accepted
- **Issue:** [#6](https://github.com/open-gsd/gsd-atlas/issues/6)
- **Ratified:** 2026-10-15
- **DESIGN.md:** A2, A8, A19, A45
- **Review findings addressed:** F‑1, F‑2, F‑3, F‑4, F‑5, F‑6

> Pre-release note: this record is not yet ratified; ratification is planned for the end of Phase 3, and every ADR will have a number by the MVP release; its Accepted status and issue number do not mean it is ratified (see docs/adr/README.md).

## Context
Every answer gsd‑atlas gives must be citable to a file and line, correct for the branch or worktree the agent is in, interoperable with gsd‑graph, and honest about how certain it is. The store needs a content identity that dedupes across branches and lets any past version be rebuilt from git.

The design review found that an earlier draft keyed *all* facts by file content. That is wrong for resolved references: what `foo()` calls depends on the other files, the config and the dependencies in that worktree, so identical file content can resolve differently on two branches. The draft also derived symbol ids from the file's content hash, so every edit renamed every symbol in the file.

## Decision
1. **Two layers of facts.**
   - **Local facts** come from one file alone: definitions, containment, imports as written, and reference sites (the name and import path as written at a span). They are keyed by the file's content hash and shared across every branch and worktree that has that content.
   - **Resolved edges** bind a reference site to its target definition. They are keyed by (overlay snapshot hash, resolution context id), where the resolution context hashes the module's config files (e.g. tsconfig chain, `Package.swift`) and the dependency lockfile. They are computed lazily per overlay and cached; overlays with the same snapshot and context share them.
2. **Fixed vocabulary per release:** `defines`, `contains`, `imports`, `reexports`, `calls`, `references`, `extends`, `extension_of`, `implements`, `conforms_to`, `overrides`, `tested_by`, `emitted_as`, `cites_adr`, `uses_sdk_symbol`, `targets_platform`. The vocabulary is a logical enum; storage is typed tables, and availability is data on SDK symbols, not predicates.
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

## Amendment 2026-10-18: Phase 3 fact kinds

Sources: 03-CONTEXT.md D-19 and D-20; 03-RESEARCH.md Patterns 4 and 6 and Seam Gaps G3, G6 and G7; 03-DECISIONS.md OQ1 and OQ3 (both researcher defaults, confirmed by the user on 2026-10-18).

Phase 3 puts five predicates of the fixed vocabulary (decision 2) to work for the first time (`cites_adr`, `emitted_as`, `extends`, `implements` and `overrides`) and adds one piece of derived bookkeeping. The vocabulary itself does not change. The decisions above stand unedited; where this section is more specific, it governs.

1. **`cites_adr` is a local fact (decision 1, layer one).** It is found by the grammar tier in code comments only, never in string literals, from the forms `ADR-<n>`, `ADR <n>` and `ADR #<n>`, matched without regard to case. The extractor keeps four things: the number as an integer (compared by value, so `ADR-1` and `0001` are the same number), a short section detail such as the one in `ADR-2143 §3`, the span of the match itself, and the enclosing symbol (the innermost symbol that contains the match, else the symbol that starts right after a leading comment, else the file). Comment text is never stored. Like every local fact it is keyed by the file's content hash and shared across branches.
2. **Citations resolve at read time (decision 8).** Which ADR files a number names depends on the ADR directory of the overlay being asked about, which can differ per branch, so resolution is not stored on the local fact. A reader joins the stored number to the ADR directory's files by value. One matching file gives one `cites_adr` fact with confidence `EXTRACTED`. Several files sharing the number give one `cites_adr` fact per file, each `INFERRED`, and the ambiguity is reported, as decision 8 requires. No matching file does not drop the fact: it is still returned, marked `unresolved`, so a question about a missing ADR document can be answered "not found" with the number of citations that exist.
3. **`emitted_as` is keyed by resolution context, not by file hash.** Which output a source file produces (a `.cts` source to a `.cjs` file, `.mts` to `.mjs`, `.ts` to `.js`, under `rootDir` and `outDir`) depends on the configuration and not on the file's bytes, so identical content on two branches can emit differently. The predicate therefore belongs with resolved data: it is derived from the module's project model and recomputed when the config hashes in the resolution context change. Declaration files never emit. The map also answers the reverse question, which source an emitted path came from, so a `require` of an emitted path resolves to the source.
4. **Meaning of "no fact under `outDir`" (OQ3, confirmed).** A file that is the emit output of an included source never receives facts and the Indexer skips it, which covers a repository that tracks its own build output. A tracked file inside `outDir` that is not the output of any included source is real code and keeps its facts; the literal reading "nothing under `outDir`" is rejected because it would remove those files.
5. **`extends`, `implements` and `overrides` from the precise tier (OQ1, confirmed).** These are symbol-to-symbol relations, and `overrides` has no reference site at all, so they cannot ride on resolved edges. A precise resolver may offer an optional `relations` method. Its results are derived data, held in a table named `resolved_relations` keyed like resolved edges by overlay snapshot and resolution context, with a per-file marker that the file was asked. They are read through `Reader.relations` ([7-fact-store-interface](7-fact-store-interface.md), amendment of the same date). Per decision 4 a compiler-resolved relation is `EXTRACTED`. A resolver without the method yields no relations and no degraded code, so the Phase 2 contract is unchanged. A relation is kept only when both endpoints map to exactly one grammar symbol under the identity rule of decision 6; otherwise it is dropped and counted, never guessed. If OQ1 had been overturned this point would state the alternative; it was not.
6. **Negative resolved-edge marker.** When a resolver is asked about a reference site and finds no edge, that negative answer is itself recorded: a derived row keyed by overlay snapshot, resolution context and site, with no target. Without it a site that has no project definition (a local alias binding, a library symbol) would be asked again on every read. The marker is not a fact, has no provenance of its own and is never shown as an edge; it is discarded with the snapshot or when the context changes, and it lets `explain` tell "asked, no edge" from "never asked".
7. **Compiler identity joins the resolution context (decision 1).** The context id already hashes the module's config files and lockfile. For a module with a compiler it also names the compiler, as version and whether it is the project's own copy or the bundled one, so edges computed by one compiler never serve a question asked under another.
