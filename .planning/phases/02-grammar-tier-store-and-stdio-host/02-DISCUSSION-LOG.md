# Phase 2: Grammar Tier, Store and stdio Host - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-16
**Phase:** 2-Grammar Tier, Store and stdio Host
**Areas discussed:** Host shape, Grammars and extraction, Result ranking and shape, Index lifecycle and freshness, Store layout and recovery, Metrics and status, ADR ratification

---

## Host shape
- Phase 2 Host: **In-process Host per stdio process** (alt: early detached daemon; in-process plus on-demand `serve`)
- Restart between calls: **Warm store, catch-up Reconcile on start** (alt: answer stale immediately; you decide)
- Follower `fresh`: **in-memory overlay per request** (alt: ask/wait for leader)

## Grammars and extraction
- Modules: **TypeScript + JavaScript** (alt: TS only; TS+JS+Python)
- Recall truth: **hand-curated fixtures + pinned gsd-core sample, TS compiler dev-only oracle** (alt: compiler-generated only; you decide)
- References: **identifier match scoped by imports** (alt: pure name match)

## Result ranking and shape
- Tools: **six-tool default profile** (alt: plus `atlas_maintain`)
- Ranking: **deterministic tiered score** (alt: plus usage-count boost)
- Cursor/budget: **opaque keyset cursor + watermark, chars/4 budget** (alt: offset cursor)
- Line text: **per-response nonce in `untrusted_text`** (alt: per-item inline fencing)

## Index lifecycle and freshness
- First run: **explicit `build`, `not_indexed` error** (alt: auto-build)
- Debounce: **100 ms trailing / 500 ms max-wait** (alt: fixed 250 ms; you decide)
- Reconcile: **start, overflow, HEAD change, idle ~10 min** (alt: start and overflow only)

## Store layout and recovery
- Crash: **dirty marker + quick_check, rebuild** (alt: quick_check only)
- Schema: **rebuild-on-bump for facts, migrations for Metrics only** (alt: migrations for both)
- GC: **in-git or 24 h grace; incremental vacuum** (alt: immediate; you decide)

## Metrics and status
- **Counters + histograms, 30-day rolling, daily rollups after 7 days** (alt: 90 days raw)

## ADR ratification
- Timing: **first plan ratifies all four + D-16 amendments** (alt: per implementing plan)
- Edits: **dated amendments where decisions differ from drafts** (alt: drafts authoritative)

## Claude's Discretion
- Fact Store internal table/index layout, start-up Reconcile deadline, fixture contents, internal naming, CI organisation.

## Deferred Ideas
- Socket Host, auth, supervisor (Phase 4); usage-count boost and compiler edges (Phase 3); auto-build, `atlas_maintain`, Python module (unscheduled).
