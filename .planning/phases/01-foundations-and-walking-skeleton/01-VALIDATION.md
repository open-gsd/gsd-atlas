---
phase: "01"
slug: "foundations-and-walking-skeleton"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-15"
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Seeded from 01-RESEARCH.md `## Validation Architecture`.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` (built in) + `c8` 12.0.0 for coverage; ESLint API used inside tests |
| **Config file** | none — Wave 0 creates `package.json` scripts, `tsconfig.json`, `eslint.config.js` |
| **Quick run command** | `node --test "src/<module>/**/*.test.ts"` |
| **Full suite command** | `npm test` (= `node --test "src/**/*.test.ts" "scripts/**/*.test.ts"`) |
| **Estimated runtime** | ~60 seconds |

---

## Sampling Rate

- **After every task commit:** Run the quick command for the touched module
- **After every plan wave:** Run `npm run lint && npm run typecheck && npm test`
- **Before `/gsd-verify-work`:** Full suite green locally, green CI on ubuntu/macos/windows x Node 24.16.0 floor/26, green `grammar:verify` on all three OSes
- **Max feedback latency:** 30 seconds per module suite

---

## Per-Task Verification Map

| Req | Behavior | Test Type | Automated Command | File Exists | Status |
|-----|----------|-----------|-------------------|-------------|--------|
| FND-01 | CI runs lint/test on 3 OS, action SHAs pinned | static + CI | `node --test scripts/ci-config.test.ts` | ❌ W0 | ⬜ pending |
| FND-02 | package name, bins, engines, files; tarball runs | unit + smoke | `node --test scripts/package.test.ts` | ❌ W0 | ⬜ pending |
| FND-03 | strict manifest, invalid module skipped, schema parity | unit | `node --test src/lang/manifest.test.ts src/lang/schema-parity.test.ts` | ❌ W0 | ⬜ pending |
| FND-04 | grammar rebuild reproduces pinned hash | integration | `npm run grammar:verify` | ❌ W0 | ⬜ pending |
| FND-05 | each seam has interface + double/conformance | contract | `node --test "src/{fact-store,source-tree,command-runner,grammar-engine,precise-resolver,governor,sqlite}/**/*.test.ts"` | ❌ W0 | ⬜ pending |
| FND-06 | no spawn outside runner; batched hash; hostile repo | unit + integration | `node --test src/command-runner/hostile-repo.test.ts` | ❌ W0 | ⬜ pending |
| FND-07 | each of 5 boundary rules fails a violation | unit | `node --test src/lint/boundaries.test.ts` | ❌ W0 | ⬜ pending |
| FND-08 | corpus manifest valid, SHAs pinned | unit | `node --test scripts/corpus.test.ts` | ❌ W0 | ⬜ pending |
| FND-09 | 8 ADRs renamed, Accepted, links resolve, schedule | unit | `node --test scripts/adr.test.ts` | ❌ W0 | ⬜ pending |
| FND-10 | dated amendment sections present | unit | `node --test scripts/adr.test.ts` | ❌ W0 | ⬜ pending |
| FND-11 | `lang test` e2e on fixture, goldens match | e2e | `node --test src/lang/lang-test.e2e.test.ts` | ❌ W0 | ⬜ pending |
| LNG-01 | precedence across 4 locations, collisions loud | integration | `node --test src/lang/registry.test.ts` | ❌ W0 | ⬜ pending |
| LNG-06 | ERROR bytes measured; budget fails when exceeded | unit + script | `node --test src/grammar-engine/measure.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `package.json`, `tsconfig*.json`, `eslint.config.js`, `.gitignore`, `.gitattributes`
- [ ] `.github/workflows/ci.yml`
- [ ] `src/test-kit/` (FakeClock, temp-git-repo builder, Windows-safe tmpdir cleanup)
- [ ] every `contract.ts` / `*.test.ts` above, `scripts/*.ts`
- [ ] throwaway three-OS grammar-hash-parity workflow
- [ ] Framework install: `npm ci --ignore-scripts`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ADR issues opened and files renamed to `<issue#>-<slug>.md` | FND-09 | Creates GitHub issues (outward-facing) | `gh issue view <n>` confirms each |
| Repaired wording for literal `\1` corruption in docs | FND-10 | User must confirm wording | Review diff |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
