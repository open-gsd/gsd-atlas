---
phase: "01"
slug: "foundations-and-walking-skeleton"
status: verified
threats_open: 0
asvs_level: 1
created: "2026-10-16"
---

# Phase 01 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Supply chain and CI | Dependencies, install scripts, workflows, grammar toolchain downloads | Packages, tarballs, workflow tokens |
| CommandRunner to child processes | Allow-listed git and tool spawns with caps, timeouts and a scrubbed env | Argument arrays, environment, stdout/stderr |
| Repository content to Source Tree | Untrusted repo text, filter names, object ids | Paths, blobs, git config |
| Language modules and grammars | Module manifests and WASM grammars loaded from user, repo and npm roots | Manifests, WASM bytes, queries |
| Fact Store / SQLite | Driver layer over `node:sqlite` and `better-sqlite3` | SQL, spans, file facts |

---

## Threat Register

Category and component are recorded verbatim in each plan's `<threat_model>` block (01-01 to 01-20 PLAN.md); this table records ID, severity, disposition, the evidence the auditor verified, and status. 54 unique threats (T-01-SC is shared by plans 01, 03, 07, 18, 19 and 20).

| Threat ID | Category | Component | Severity | Disposition | Mitigation (verified evidence) | Status |
|-----------|----------|-----------|----------|-------------|--------------------------------|--------|
| T-01-01 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | package.json exact pins and allowScripts; CI `npm ci --ignore-scripts`; scripts/ci-config.test.ts, scripts/package.test.ts, scripts/ensure-tree-sitter.ts; human gates in 01-01-SUMMARY.md | closed |
| T-01-SC | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | package.json exact pins and allowScripts; CI `npm ci --ignore-scripts`; scripts/ci-config.test.ts, scripts/package.test.ts, scripts/ensure-tree-sitter.ts; human gates in 01-01-SUMMARY.md | closed |
| T-01-02 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | package.json exact pins and allowScripts; CI `npm ci --ignore-scripts`; scripts/ci-config.test.ts, scripts/package.test.ts, scripts/ensure-tree-sitter.ts; human gates in 01-01-SUMMARY.md | closed |
| T-01-03 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | scripts/adr.ts header-only ratify with tests; repo private, title-only bodies (01-02-SUMMARY.md); docs/adr/README.md editorial log; UAT test 1 pass | closed |
| T-01-04 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | scripts/adr.ts header-only ratify with tests; repo private, title-only bodies (01-02-SUMMARY.md); docs/adr/README.md editorial log; UAT test 1 pass | closed |
| T-01-05 | see 01-*-PLAN.md threat_model | see plan register | low | mitigate | scripts/adr.ts header-only ratify with tests; repo private, title-only bodies (01-02-SUMMARY.md); docs/adr/README.md editorial log; UAT test 1 pass | closed |
| T-01-06 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | ci.yml permissions and SHA pins; eslint.config.js purity and dynamic import/require selectors; src/lint/boundaries.test.ts; scripts/package.test.ts dist scan and pack whitelist | closed |
| T-01-07 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | ci.yml permissions and SHA pins; eslint.config.js purity and dynamic import/require selectors; src/lint/boundaries.test.ts; scripts/package.test.ts dist scan and pack whitelist | closed |
| T-01-42 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | ci.yml permissions and SHA pins; eslint.config.js purity and dynamic import/require selectors; src/lint/boundaries.test.ts; scripts/package.test.ts dist scan and pack whitelist | closed |
| T-01-40 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | ci.yml permissions and SHA pins; eslint.config.js purity and dynamic import/require selectors; src/lint/boundaries.test.ts; scripts/package.test.ts dist scan and pack whitelist | closed |
| T-01-09 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | src/facts/file-facts.ts and span.ts validators (writer call site lands in Phase 2); src/test-kit/tmpdir.ts closes handles before rmSync | closed |
| T-01-10 | see 01-*-PLAN.md threat_model | see plan register | low | mitigate | src/facts/file-facts.ts and span.ts validators (writer call site lands in Phase 2); src/test-kit/tmpdir.ts closes handles before rmSync | closed |
| T-01-11 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | scripts/corpus.ts and corpus-check.ts accept only full 40/64 lowercase hex SHAs | closed |
| T-01-12 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | src/lang/manifest.ts path regex, bounds, try/catch; src/lang/module-files.ts realpath containment and size caps; src/grammar-engine/limits.ts, check.ts, load.ts (caps, then sha256, then Language.load) | closed |
| T-01-13 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | src/lang/manifest.ts path regex, bounds, try/catch; src/lang/module-files.ts realpath containment and size caps; src/grammar-engine/limits.ts, check.ts, load.ts (caps, then sha256, then Language.load) | closed |
| T-01-37 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | src/lang/manifest.ts path regex, bounds, try/catch; src/lang/module-files.ts realpath containment and size caps; src/grammar-engine/limits.ts, check.ts, load.ts (caps, then sha256, then Language.load) | closed |
| T-01-29 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | src/lang/manifest.ts path regex, bounds, try/catch; src/lang/module-files.ts realpath containment and size caps; src/grammar-engine/limits.ts, check.ts, load.ts (caps, then sha256, then Language.load) | closed |
| T-01-14 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | manifest.ts is data only; src/lang/registry.ts diagnoses and skips, never runs module code; registry.test.ts and lang-test.e2e.test.ts | closed |
| T-01-36 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | manifest.ts is data only; src/lang/registry.ts diagnoses and skips, never runs module code; registry.test.ts and lang-test.e2e.test.ts | closed |
| T-01-38 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | manifest.ts is data only; src/lang/registry.ts diagnoses and skips, never runs module code; registry.test.ts and lang-test.e2e.test.ts | closed |
| T-01-15 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | grammar-engine load.ts hash check; scripts/grammar-verify.ts; ensure-tree-sitter.ts version equality; src/lang/grammar-lock.ts and scripts/grammar-build.ts https/file only with archive sha256 (residual: CLI/wasi/binaryen fetched without per-asset hash, accepted as written in the plan) | closed |
| T-01-16 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | grammar-engine load.ts hash check; scripts/grammar-verify.ts; ensure-tree-sitter.ts version equality; src/lang/grammar-lock.ts and scripts/grammar-build.ts https/file only with archive sha256 (residual: CLI/wasi/binaryen fetched without per-asset hash, accepted as written in the plan) | closed |
| T-01-18 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | scripts/adr.test.ts verbatim-fragment and append-only checks; Node floor 24.16 recorded in PROJECT.md, REQUIREMENTS.md, 01-CONTEXT.md, README.md | closed |
| T-01-19 | see 01-*-PLAN.md threat_model | see plan register | low | mitigate | scripts/adr.test.ts verbatim-fragment and append-only checks; Node floor 24.16 recorded in PROJECT.md, REQUIREMENTS.md, 01-CONTEXT.md, README.md | closed |
| T-01-20 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | src/command-runner/real.ts decide before spawn, shell false, caps and SIGKILL timeout; decide.ts; exec-resolve.ts; env.ts; contract.ts (denied starts nothing) | closed |
| T-01-21 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | src/command-runner/real.ts decide before spawn, shell false, caps and SIGKILL timeout; decide.ts; exec-resolve.ts; env.ts; contract.ts (denied starts nothing) | closed |
| T-01-22 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | src/command-runner/real.ts decide before spawn, shell false, caps and SIGKILL timeout; decide.ts; exec-resolve.ts; env.ts; contract.ts (denied starts nothing) | closed |
| T-01-23 | see 01-*-PLAN.md threat_model | see plan register | low | mitigate | src/command-runner/real.ts decide before spawn, shell false, caps and SIGKILL timeout; decide.ts; exec-resolve.ts; env.ts; contract.ts (denied starts nothing) | closed |
| T-01-24 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | src/sqlite/open.ts version floor and NUL self-test; node-sqlite.ts allowExtension false; driver.ts allowlist without loadExtension; normalize.ts, wrap.ts, contract.ts | closed |
| T-01-25 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | src/sqlite/open.ts version floor and NUL self-test; node-sqlite.ts allowExtension false; driver.ts allowlist without loadExtension; normalize.ts, wrap.ts, contract.ts | closed |
| T-01-26 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | src/sqlite/open.ts version floor and NUL self-test; node-sqlite.ts allowExtension false; driver.ts allowlist without loadExtension; normalize.ts, wrap.ts, contract.ts | closed |
| T-01-28 | see 01-*-PLAN.md threat_model | see plan register | low | mitigate | src/governor/fake.ts; src/grammar-engine/with-tree.ts, measure.ts, engine.ts; eslint rule limiting parse to withTree | closed |
| T-01-31 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | src/governor/fake.ts; src/grammar-engine/with-tree.ts, measure.ts, engine.ts; eslint rule limiting parse to withTree | closed |
| T-01-32 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | src/command-runner/git-spec.ts and decide.ts; src/source-tree/real.ts and validate.ts; hostile-repo.test.ts | closed |
| T-01-33 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | src/command-runner/git-spec.ts and decide.ts; src/source-tree/real.ts and validate.ts; hostile-repo.test.ts | closed |
| T-01-34 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | src/command-runner/git-spec.ts and decide.ts; src/source-tree/real.ts and validate.ts; hostile-repo.test.ts | closed |
| T-01-35 | see 01-*-PLAN.md threat_model | see plan register | low | mitigate | src/command-runner/git-spec.ts and decide.ts; src/source-tree/real.ts and validate.ts; hostile-repo.test.ts | closed |
| T-01-39 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | Human gate in 01-15-SUMMARY.md: repo confirmed private, non-force push | closed |
| T-01-43 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | git-spec.ts and decide.ts; hostile-repo.test.ts; git-spec.test.ts | closed |
| T-01-44 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | git-spec.ts and decide.ts; hostile-repo.test.ts; git-spec.test.ts | closed |
| T-01-46 | see 01-*-PLAN.md threat_model | see plan register | critical | mitigate | git-spec.ts probe and decide.ts; decide.test.ts, git-spec.test.ts, hostile-repo.test.ts | closed |
| T-01-47 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | git-spec.ts probe and decide.ts; decide.test.ts, git-spec.test.ts, hostile-repo.test.ts | closed |
| T-01-48 | see 01-*-PLAN.md threat_model | see plan register | high | mitigate | git-spec.ts probe and decide.ts; decide.test.ts, git-spec.test.ts, hostile-repo.test.ts | closed |
| T-01-50 | see 01-*-PLAN.md threat_model | see plan register | critical | mitigate | git-spec.ts; src/command-runner/filter-name.ts shared by decide.ts and git-spec.ts; hostile-repo.test.ts (4 byte forms, 1025 refused, 1024 snapshots); git-spec.test.ts | closed |
| T-01-51 | see 01-*-PLAN.md threat_model | see plan register | medium | mitigate | git-spec.ts; src/command-runner/filter-name.ts shared by decide.ts and git-spec.ts; hostile-repo.test.ts (4 byte forms, 1025 refused, 1024 snapshots); git-spec.test.ts | closed |
| T-01-52 | see 01-*-PLAN.md threat_model | see plan register | low | mitigate | git-spec.ts; src/command-runner/filter-name.ts shared by decide.ts and git-spec.ts; hostile-repo.test.ts (4 byte forms, 1025 refused, 1024 snapshots); git-spec.test.ts | closed |
| T-01-53 | see 01-*-PLAN.md threat_model | see plan register | low | mitigate | git-spec.ts; src/command-runner/filter-name.ts shared by decide.ts and git-spec.ts; hostile-repo.test.ts (4 byte forms, 1025 refused, 1024 snapshots); git-spec.test.ts | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*

---

## Accepted Risks Log

| Threat Ref | Disposition | Severity | Status | Rationale |
|------------|-------------|----------|--------|-----------|
| T-01-08 | accept | low | closed | No secrets in ci.yml (0 matches) |
| T-01-17 | accept | medium | closed | Only local sources used (test/fixtures/modules/toy/grammar.lock) |
| T-01-27 | accept | low | closed | Noop governor, src/governor/noop.ts:10 |
| T-01-30 | accept | medium | closed | 256 KiB query cap, src/grammar-engine/limits.ts:9 |
| T-01-41 | accept | low | closed | scripts/package.test.ts:338 plus exact pins |
| T-01-45 | accept | low | closed | GIT_ALLOW_PROTOCOL=none, git-spec.ts:127 |
| T-01-49 | accept | low | closed | Fail-closed E2BIG (review WR-04) |

*Dispositions are those set in the phase plans' threat registers. Accepted risks do not resurface in future audit runs.*

---

## Tracked Residuals (not counted in threats_open)

Recorded in 01-REVIEW-DISPOSITION.md; fix before Phase 2 builds on `decide`.

- WR-02: `decide.ts` option denylist is bypassable (`rev-list --output=`, bundled `hash-object -w`); latent because no call site puts untrusted text in option position. Touches T-01-20 and T-01-44.
- WR-03: `decide.ts` env check is presence-only. Touches T-01-20 and T-01-44.
- WR-04: aggregate env size can cause E2BIG (T-01-49, T-01-52).
- IN-04: `git-spec.ts` `shown()` leaves C1, bidi and U+2028 characters raw (T-01-53, low).
- No default CommandRunner timeout is set (60 s held back; UAT test 3). The hung-child bound for T-01-21 and T-01-35 is opt-in per spec; the mechanism is present and tested.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-16 | 54 | 54 | 0 | gsd-security-auditor (code read plus 714 unit tests and 131 script tests, 0 failures; eslint src clean) |

Unregistered threat flags: none.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-10-16 (automated audit)
