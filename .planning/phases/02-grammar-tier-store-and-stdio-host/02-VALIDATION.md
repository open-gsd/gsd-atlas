---
phase: "02"
slug: "grammar-tier-store-and-stdio-host"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-16"
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test (native type stripping) + c8 12.0.0 |
| **Config file** | none — scripts in package.json |
| **Quick run command** | `node --test "src/<module>/*.test.ts"` |
| **Full suite command** | `npm test && npm run lint && npm run typecheck && npm run build` |
| **Estimated runtime** | ~2 seconds |

---

## Sampling Rate

- **After every task commit:** Run `node --test "src/<module>/*.test.ts"`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 2 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 2-XX | TBD | TBD | STO-01, STO-04 | — | see plan threat model | contract | `node --test "src/fact-store/*.test.ts"` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | STO-02, STO-03 | — | see plan threat model | integration | `node --test "src/indexer/*.test.ts"` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | STO-05 | — | see plan threat model | gate | `node scripts/size-gate.ts` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | STO-06, STO-07, STO-08, STO-10 | — | see plan threat model | integration | `node --test "src/fact-store/*.test.ts"` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | STO-09 | — | see plan threat model | integration | `node --test src/cli/history.test.ts` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | LNG-02 | — | see plan threat model | gate | `node scripts/recall.ts --corpus gsd-core` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | LNG-03, LNG-04, LNG-07, LNG-08 | — | see plan threat model | unit/integration | `node --test "src/grammar-engine/*.test.ts"` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | LNG-05 | — | see plan threat model | integration | `node --test "src/source-tree/*.test.ts"` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | IDX-01..IDX-04 | — | see plan threat model | integration | `node --test "src/indexer/*.test.ts" "src/query/fresh.test.ts"` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | QRY-01..QRY-03, QRY-05 | — | see plan threat model | unit/golden | `node --test "src/query/*.test.ts"` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | QRY-04, QRY-06 | — | see plan threat model | e2e | `node --test src/cli/parity.test.ts "src/mcp-shim/*.test.ts"` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | HST-01..HST-03 | — | see plan threat model | e2e | `node --test "src/host/*.test.ts" "src/mcp-shim/*.test.ts" "src/governor/*.test.ts"` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | HST-04 | — | see plan threat model | unit | `node --test src/cli/init.test.ts` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | MET-01, MET-02 | — | see plan threat model | unit | `node --test "src/metrics/*.test.ts"` | ❌ W0 | ⬜ pending |
| 2-XX | TBD | TBD | FND-12 | — | see plan threat model | doc | `node --test scripts/adr.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/fact-store/contract.ts` — contract suite for both drivers (STO-01)
- [ ] Indexer harness: `ManualEventSource`, temp repos with worktrees (IDX-*, STO-03)
- [ ] Child-process helpers for kill/lease tests via `createRealRunner`
- [ ] Fixtures: CRLF, BOM, emoji, LFS pointer, binary, linguist-generated, injection comment, two-branch resolution
- [ ] `scripts/recall.ts`, `scripts/size-gate.ts`, pinned-SHA corpus fetch helper
- [ ] ESLint MODULES additions plus a boundary fixture test per new module

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Windows/Linux behaviour of watcher, lease, sockets | HST-01, IDX-01, STO-08 | Only three-OS CI can run them | Inspect CI matrix results for the PR |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 2s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** {pending / approved YYYY-MM-DD}
