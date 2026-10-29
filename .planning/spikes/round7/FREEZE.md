# Round 7 freeze record (2026-10-29)

Recorded before any variant is timed. Nothing has been run in this round.

| Item | sha256 |
|---|---|
| plan-section-16.frozen.md | a2ace5643afe6447b55f5ac709fa685cd00aba3a60b209087e5122a5fda732b8 |

## Amendments
### A1 (2026-10-29, before any variant is timed)
bench7.mjs sha256 c91c7e9498a93b093133251c600f100b7698086c9164cb216ebeb7eb1a56c0fe. Deviation from plan 16.2, stated before running: each variant runs its 3 repetitions back to back (variants in the fixed order T0, T1, T2-n2/4/8, T3, T4) instead of rotating variant order per repetition, because T3 and T4 depend on the winner of earlier variants. Drift over the run (thermal, load) can therefore favour earlier variants; host load and CPU idle are recorded around each repetition and T0 is not repeated at the end. The full-pack run, if any, is a separate script hashed before it is used.
