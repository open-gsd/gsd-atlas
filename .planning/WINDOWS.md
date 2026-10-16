---
schema_version: 1
open_count: 1
waived_count: 0
fixed_count: 0
total_count: 1
last_updated: 2026-10-16T19:14:47.479Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 02 | stub | src/fact-store/store.ts |  | collect, compact, check and maintain return an empty successful result until plan 02-18 | open |  | 2026-10-16T19:14:47.479Z |  |

````json
[
  {
    "id": 1,
    "kind": "stub",
    "phase": "02",
    "file": "src/fact-store/store.ts",
    "line": null,
    "description": "collect, compact, check and maintain return an empty successful result until plan 02-18",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-16T19:14:47.479Z",
    "resolved_at": null,
    "milestone": null
  }
]
````
