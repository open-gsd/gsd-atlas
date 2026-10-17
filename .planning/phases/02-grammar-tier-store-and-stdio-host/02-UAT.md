---
status: testing
phase: 02-grammar-tier-store-and-stdio-host
source: [02-VERIFICATION.md]
started: 2026-10-17T17:03:28Z
updated: 2026-10-17T17:03:28Z
---

## Current Test

number: 1
name: STO-05 idle-only size policy
expected: |
  Idle loop alone keeps the store at or below 1.25x a fresh build after 20,000 edits (measured 1.396x), or the owner records an override accepting that the bound holds only after `gsd-atlas maintain compact --full`.
awaiting: user response

## Tests

### 1. STO-05 idle-only size policy
expected: idleRatio <= 1.25 without an explicit full compaction, or a written override
result: [pending]

### 2. Cursor and Codex init config shapes
expected: Each real host lists and starts the gsd-atlas MCP server from the entry init wrote; init changes nothing else
result: [pending]

### 3. nightly.yml first remote run
expected: freshness-gate (100 saves, 1000 ms) and corpus-gates pass on ubuntu, macOS and Windows after the file reaches the default branch
result: [pending]

### 4. ADR editorial repairs and amendments from 02-01
expected: Reconstructed passages and six 2026-10-16 amendments accepted; lost clause in docs/SDK-PROVIDERS.md supplied or left by choice
result: [pending]

### 5. Flaky wall-clock assertion in src/fact-store/maintain.test.ts
expected: Bound the first compaction slice in the product, or assert page counts instead of wall time
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
