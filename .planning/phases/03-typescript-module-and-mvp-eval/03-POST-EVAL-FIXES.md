# Phase 3 post-eval fixes

Three small fixes made after the scored run finished (verdict recorded in `docs/eval/analysis.md`).

## Measured-commit caveat

The registered scored run measured atlas commit `37b12e32bf84f9ca1a4052c7d574ebc1aa0fe207`. The fixes below came after it, so the atlas build on `main` now differs from the build that was measured. The Stage A/B scripts, the preregistration, the analysis, the diagnosis and the results were not touched; a clean-room replication still uses the registered commit, so these changes do not affect it. `SCHEMA_VERSION` stays 2 and `MODULES.length` stays 23. ADRs are untouched (ratification is plan 03-37).

## 1. `explain` reported every grammar-tier fact as stale (owner plan 03-26)

- Cause: the explain port (`src/tenant/create.ts`) returned the module's manifest `version` (`0.1.0`) as the current grammar version. Facts are stamped with the pinned grammar version (`0.23.2` for typescript, `0.25.0` for javascript), so the two never matched and `fact.stale` became true with a `currentGrammarVersion` of `0.1.0`.
- Fix: one rule, `grammarVersionOf(lock, manifest)` in `src/lang/module-files.ts`, now serves both the module host (which stamps the facts) and the explain port (through `readGrammarVersion(moduleDir)`, which reads the manifest and lock only).
- Other consumers checked: `atlas_status` tiers (`src/tenant/status-port.ts`) and the module list in `src/host/host.ts` and the bug bundle report the manifest version as the module version, which is correct; the watermark `stalePaths` comes from the overlay and has no grammar version; nothing in production calls `markStale`. No other consumer had the mix-up.
- Tests: `scripts/explain-e2e.test.ts` (real bins over a fixture repo: build, then explain a javascript reference, a typescript reference and the definition; `stale` false, no `currentGrammarVersion`); `src/lang/module-files.test.ts` (`readGrammarVersion`, `grammarVersionOf`). The existing `src/query/explain.test.ts` cases already cover the stale-when-the-version-really-differs path.
- Docs: no page stated the wrong behaviour; none changed. The tutorial keeps the `answer_id` form of `explain`.
- Commits: red `fd5600f`, green `b9b5f96`.

## 2. `rate` hint named an option that does not exist (owner plan 03-17)

- Decision: the plan gives the CLI exactly three scopes (`--last`, `--session`, `--feature`); the Host request has an `answer_id` argument that the CLI does not expose. The minimal change that makes message and behaviour agree is to correct the message, so no CLI surface was added.
- Message is now: "There is no recent answer to rate. Ask a question first." (`src/tenant/rate.ts`).
- Test: `src/host/rate.test.ts`. Docs: `docs/how-to/rate-an-answer.md` no longer has to explain the mismatch; `docs/reference/cli.md` was already correct.
- Commits: red `7c1794b`, green `3b28d32`.

## 3. Bug page name restored

- `git mv docs/how-to/write-a-bug-bundle.md docs/how-to/report-a-bug.md`; references updated in `README.md`, `docs/reference/alpha-limitations.md`, `docs/reference/cli.md`, `docs/explanation/how-atlas-decides-what-to-trust.md`, `scripts/docs-reference.test.ts` and `03-DOCS-LEDGER.md`. The 03-36 summary keeps its record of the deviation.
- As the 03-36 deviation notes say, no command removes a bug bundle (`bug --clear` only empties the flight recorder); the docs still say so.
- Commit: `e2f0cde`.
