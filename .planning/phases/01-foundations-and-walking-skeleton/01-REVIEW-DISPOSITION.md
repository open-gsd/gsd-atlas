---
phase: 01-foundations-and-walking-skeleton
review: 01-REVIEW.md
---

# Review disposition (re-review after plans 01-18, 01-19)

| Finding | Severity | Disposition |
|---------|----------|-------------|
| CR-01 non-UTF-8 driver name decoded lossily, bypasses neutralisation | Critical | open |
| WR-01 decide refuses CR in driver name that neutraliseFilters emits | Warning | open |
| WR-02 option denylist bypassable (cat-file --textconv, hash-object -w) | Warning | open (latent) |
| WR-03 decide checks pinned env by presence only | Warning | open |
| IN-01 missing tests: invalid-UTF-8, CR, long names | Info | open |
| IN-02 env.ts GIT_CONFIG KEY_n/VALUE_n handling | Info | open |
| IN-03 redundant casts / spacing typo | Info | open |

Prior CR-01 (promisor lazy fetch) and prior CR-02 (driver name with `=`): closed by 01-18 and 01-19 per this review.
