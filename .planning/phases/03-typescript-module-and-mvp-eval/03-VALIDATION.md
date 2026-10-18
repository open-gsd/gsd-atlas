---
phase: "3"
slug: "typescript-module-and-mvp-eval"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-18"
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. The requirement-to-test map lives in `03-RESEARCH.md` under "Validation Architecture"; the planner copies it into the Per-Task Verification Map.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` with native type stripping, `c8` 12.0.0 |
| **Config file** | none; scripts in package.json (`test`, `coverage`) |
| **Quick run command** | `node --test "src/<module>/*.test.ts"` |
| **Full suite command** | `npm test && npm run lint && npm run typecheck && npm run build` |
| **Estimated runtime** | seconds per module; worker tests add process starts, so share one worker per file |

---

## Sampling Rate

- **After every task commit:** Run the module's quick command
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite plus the PR-tier TSM-06 gate green on three OSes, `verify-prereg` green, scored-run analysis committed
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| (filled by planner from 03-RESEARCH.md Validation Architecture) | | | | | | | | | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `docs/eval/free-alternatives.md` and live-run notes (EVL-01)
- [ ] `scripts/eval/` questions, oracle, stats, harness skeleton, pilot, `docs/eval/preregistration.md` (EVL-02)
- [ ] `03-CONSTANTS.md` approved; package installs approved
- [ ] ADR ratifications and amendments (diagnostics ADR; ADR 5, 6, 7, 13)
- [ ] Fixture repos: classes/interfaces/abstract methods, CRLF/BOM/U+2028, `.cts` emit repo, two-branch precise repo, fake `typescript` 7.1-layout packages, hostile-config repo
- [ ] `eslint.config.js` MODULES entries for each new module plus one boundary test each

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Scored eval run against live agents | EVL-03 | Needs `claude` CLI, OAuth and cost; local only | Run the harness after preregistration freeze; commit analysis |
| Windows/Linux precise-resolver timings | TSM-06 | No local machines | Read the three-OS CI gate output |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
