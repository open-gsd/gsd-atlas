---
phase: 01-foundations-and-walking-skeleton
review: 01-REVIEW.md
---

# Review disposition (re-review after plan 01-20)

| Finding | Severity | Disposition |
|---------|----------|-------------|
| CR-01 non-UTF-8 driver name decoded lossily, bypasses neutralisation | Critical | resolved by 01-20 (d7b7354); confirmed by re-review and by CI on 5a1caa0 |
| WR-01 decide refuses CR in driver name that neutraliseFilters emits | Warning | resolved by 01-20 (b28e273) |
| WR-02 option denylist bypassable (`decide.ts:44`) | Warning | open (latent); schedule before Phase 2 builds on decide |
| WR-03 decide checks pinned env by presence only (`decide.ts:79-85`) | Warning | open; schedule before Phase 2 builds on decide |
| WR-04 total env size unbounded; 300 long `[filter]` sections give opaque `spawn E2BIG`; the cross-platform comment on the 1024 cap is false (`filter-name.ts:18-20`, `git-spec.ts:85-89`) | Warning | open (new); fails closed, DoS on own indexing only |
| IN-01 protection tests do not depend on their positive control | Info | open (CR, invalid-UTF-8 and long-name gaps closed by 01-20) |
| IN-02 env.ts GIT_CONFIG KEY_n/VALUE_n handling | Info | open |
| IN-03 redundant casts (`decide.ts:175`) / spacing typo (`source-tree.test.ts:97`) | Info | open |
| IN-04 `shown()` leaves C1 controls, bidi overrides, U+2028 raw (`git-spec.ts:195-206`) | Info | open (new) |
| IN-05 remedy text says "repository config" though the listing reads all scopes (`git-spec.ts:208`) | Info | open (new) |
| IN-06 tab/leading-space/trailing-space cases cannot fail as protection tests (`hostile-repo.test.ts`, `REPRESENTABLE`) | Info | open (new) |

No Critical findings stand. Prior CR-01 (promisor lazy fetch) and prior CR-02 (driver name with `=`): closed by 01-18 and 01-19.
