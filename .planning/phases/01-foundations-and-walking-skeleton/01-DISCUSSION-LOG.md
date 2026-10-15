# Phase 1: Foundations and Walking Skeleton - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-15
**Phase:** 1-Foundations and Walking Skeleton
**Areas discussed:** Fixture module & lang test, Grammar build & parse budget, Seam test doubles, Lint/CI/ADR ratification, Manifest schema shape, CommandRunner scope, Repo layout & scripts

---

## Fixture module & lang test

| Option | Description | Selected |
|--------|-------------|----------|
| Tiny toy grammar | Owned mini-language, fast, deterministic, reusable in Phase 2 | ✓ |
| Real tree-sitter-javascript | Real pipeline now, brings 0.45% parse errors | |
| Real tree-sitter-python | Clean grammar, de-risks Phase 9 | |

| Option | Description | Selected |
|--------|-------------|----------|
| Golden spans + fixtures | Compare spans to checked-in goldens (UTF-16, CRLF, BOM) | ✓ |
| Smoke only | Manifest/grammar/queries load, one span | |
| Golden + parse-quality report | Also prints ERROR-bytes inside lang test | |

| Option | Description | Selected |
|--------|-------------|----------|
| Fixture in all 4 sources | Real directory layouts, precedence asserted | ✓ |
| Resolution logic + unit tests only | Fake paths | |

**User's choice:** Toy grammar; golden spans; fixture in all 4 sources.

---

## Grammar build & parse budget

| Option | Description | Selected |
|--------|-------------|----------|
| Commit wasm + pinned sha256 | 3-OS CI rebuild check | ✓ |
| Build in CI only | Nothing binary in git | |
| Commit wasm, Linux-only check | Cheaper, misses Windows/macOS drift | |

| Option | Description | Selected |
|--------|-------------|----------|
| Per-module manifest budget | Default 0.5% ERROR bytes, fails CI | ✓ |
| Global threshold | One repo-wide number | |
| Report-only | Conflicts with roadmap | |

| Option | Description | Selected |
|--------|-------------|----------|
| Per-module grammar.lock | Module owns pins, patches, licence, hash | ✓ |
| Central grammars.json | One root file | |

**User's choice:** Commit wasm with pinned hash; per-module budget; per-module grammar.lock.

---

## Seam test doubles

| Option | Description | Selected |
|--------|-------------|----------|
| Interface + driver layer + conformance | Both SQLite drivers, no tables yet | ✓ |
| Interface + minimal real store | Pulls Phase 2 forward | |
| Interface types only | Driver risk unverified | |

| Option | Description | Selected |
|--------|-------------|----------|
| Interface + fake + shared contract test | Fake and real run the same contract | ✓ |
| Interface + fake only | Fakes may drift | |

**User's choice:** Driver layer + conformance for Fact Store; fake + shared contract for other seams.

---

## Lint, CI & ADR ratification

| Option | Description | Selected |
|--------|-------------|----------|
| ESLint only | Single tool, fixture test per rule | ✓ |
| ESLint + dependency-cruiser | Second tool | |

| Option | Description | Selected |
|--------|-------------|----------|
| 3 OS x Node 24.15 + 26, xcode-27 later | | ✓ |
| 3 OS x Node 24.15 only | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Create remote, open issues via gh | Rename, amend, Accept | ✓ |
| Local numbering now, issues later | Violates FND-09 | |
| Defer ratification | Contradicts roadmap | |

**ADR open questions:** warm() = bounded by timeoutMs, no warm() ✓; watcher inside Indexer ✓; ensureFresh slot per request, LRU on file set ✓.

---

## Manifest schema shape

| Option | Description | Selected |
|--------|-------------|----------|
| Full v1 fields, versioned | Freeze now | ✓ |
| Minimal, grow with phases | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Committed schemas/ dir with CI drift check | | ✓ |
| Generated at build only | | |

---

## CommandRunner scope

| Option | Description | Selected |
|--------|-------------|----------|
| Full surface now | Streaming, batched stdin, caps, Windows resolution, recording fake | ✓ |
| Spawn + batch only | | |

---

## Repo layout & scripts

| Option | Description | Selected |
|--------|-------------|----------|
| src/<seam>/index.ts, modules/ for languages | | ✓ |
| Let planner decide | | |

---

## Claude's Discretion

Toy-grammar design, fixture contents beyond required cases, internal naming, CI workflow file organisation.

## Deferred Ideas

- `xcode-27` CI lane (Phase 6)
- Real fact tables, writer lease, maintenance (Phase 2)
- Writer-contention and metrics-migration amendments (Phase 2 ratification)
- Real-grammar parse budgets (Phases 2, 3, 5)
