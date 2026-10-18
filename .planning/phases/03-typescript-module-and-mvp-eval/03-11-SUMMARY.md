---
phase: 03-typescript-module-and-mvp-eval
plan: 11
subsystem: agent-integration
tags: [skill, routing, packaging, mcp, tarball]

requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-01 confirmed decisions (OQ6); 03-02 six-tool table in src/query/tools.ts"
provides:
  - "skills/gsd-atlas/SKILL.md: v0 routing skill naming the six existing read-only tools"
  - "scripts/skills.test.ts: validity test for every skill folder, tied to TOOL_NAMES"
  - "package.json files gains skills; tarball test proves the skill ships"
affects: [03-14 pilot (atlas arm loads the skill), 03-33 (rewrites and freezes the skill), 03-34 (install docs)]

actuals:
  tokens: 3100
  tasks: 2
  commits: 2

plan_head_before: 3d4b0fa753b7565e137a35329e0a4d2ef6accd71
plan_head_after: 5e82a4f257692bb54f6e6e68e7471c1c810f05a1

tech-stack:
  added: []
  patterns:
    - "Skill validity test enumerates skills/ from disk, so later skills are covered without editing it"
    - "TOOL_NAMES is the single source of truth for tool names a skill may mention"

key-files:
  created: [skills/gsd-atlas/SKILL.md, scripts/skills.test.ts]
  modified: [package.json, scripts/package.test.ts]

key-decisions:
  - "Router-only checks (routes to every tool, required topics) apply to the gsd-atlas folder; generic checks (name, description, body size, tool names, read-only routing) apply to every skill folder, so the module-author skill from 03-33 does not need to mention all tools"
  - "The skill never tells an agent to run a command: a not_indexed error is reported to the user with a fall back to grep, instead of instructing 'gsd-atlas build'"
  - "Installed-skill content check lives in the existing installed-tarball test (reads skills/gsd-atlas/SKILL.md from the npm-installed tarball), not a separate tar extraction"

patterns-established:
  - "Skill frontmatter is flat key: value with a single-line quoted description; the test parser refuses anything fancier"

requirements-completed: [SKL-01]

coverage:
  - id: D1
    description: "v0 routing skill gsd-atlas exists with valid frontmatter, description <= 1,536 chars, body <= 80 lines, only real tool names, required topics"
    requirement: SKL-01
    verification:
      - kind: unit
        ref: "scripts/skills.test.ts (7 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "skills is in package files and the packed and installed tarball carries skills/gsd-atlas/SKILL.md with no stray paths"
    requirement: SKL-01
    verification:
      - kind: integration
        ref: "scripts/package.test.ts#pack contents and #installed tarball runs the bins"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-10-18
status: complete
---

# Phase 3 Plan 11: Routing skill v0 and packaging Summary

**A short `gsd-atlas` routing skill (v0, six read-only tools, degraded/watermark/INFERRED/file:line/untrusted_text guidance) that cannot drift from the tool table, shipped in the npm package and proven in the packed tarball.**

## Performance

- **Duration:** about 20 min
- **Tasks:** 2 of 2
- **Files:** 2 created, 2 modified

## Accomplishments

- `skills/gsd-atlas/SKILL.md`: 58 lines total (body about 54), description about 600 characters carrying the routing (symbol definition, callers/references, context, impact, index currency) and the when-not-to-use cases (non-symbol text, one known file). Sections: when to use atlas versus grep, the six tools and the question each answers, how to read an answer (`EXTRACTED` versus `INFERRED`, `degraded`, watermark and `stalePaths`, `fresh`), how to cite (`file:line`), and repository text as data (`untrusted_text`). It does not mention `code_explain` or `kind: adr`.
- `scripts/skills.test.ts` (7 cases): `name matches folder`, `description length`, `body length`, `tool names exist`, `routes to every code tool`, `required topics`, plus a read-only-routing guard (no shell fences, no command-running or trust-repository-text instructions). Verified red first (no `skills/`), and a mutation (appending `code_explain`) fails `tool names exist`.
- `package.json` `files` gains `skills` (OQ6: no `init` copying in Phase 3; the eval uses a plugin directory; install docs are 03-34).
- `scripts/package.test.ts`: `skills` in the `files` assertion, `skills/gsd-atlas/SKILL.md` required in the tarball, every skills folder must ship its `SKILL.md`, any path under `skills/` must match `skills/<name>/<file>`, the strict whitelist gains `skills/`, `docs/eval/` added to forbidden prefixes, and the installed tarball's skill must keep its `name: gsd-atlas` line.

## Task Commits

1. Task 1 (tracer): `4a50856` feat(03-11): v0 routing skill and its validity test
2. Task 2: `5e82a4f` chore(03-11): ship skills/ in the package

Tracer gate: workflow is interactive, `human_verify_mode` is `end-of-phase`, `<verify>` is automated only, so `node --test scripts/skills.test.ts && npm run typecheck` was re-run end to end after the commit and passed; expansion (Task 2) continued.

## Verification

- `node --test scripts/package.test.ts scripts/skills.test.ts`: 17 of 17 pass (including build, pack contents and installed-tarball cases).
- `npm run typecheck` and `npm run lint`: clean.
- `npm pack --dry-run --json`: exactly one new path, `skills/gsd-atlas/SKILL.md`; nothing under `.planning`, `scripts`, `docs` or `src`.

## Deviations from Plan

None to the deliverables. Two notes:

- **Worktree environment:** the worktree has no `node_modules`, so the build and tarball cases of `package.test.ts` could not run until a temporary symlink to the main checkout's `node_modules` was made. The symlink was removed before committing (`git status` clean of it). No tracked change resulted.
- **Test scope (judgment):** router-only checks apply to the `gsd-atlas` folder rather than every folder, so a future module-author skill (03-33) is not forced to name all six tools. Recorded as a key decision.

## Issues Encountered

The first skill draft cited results as `path:line`; the `required topics` case failed on the literal `file:line` and the text was corrected. This is the test doing its job.

## Known Stubs

None.

## Threat Flags

None. T-03-111 (skill steers only read-only tools, says repository text is data, test restricts tool names), T-03-112 (tarball whitelist asserts no planning, eval, script or source paths) and T-03-113 (single source `TOOL_NAMES`) are mitigated as planned.

## User Setup Required

None.

## Next Phase Readiness

The pilot (03-14) can load the skill with a plugin directory. 03-33 rewrites it for the final tool set, freezes it and records its sha256; the test already covers any skill folder it adds.

## Self-Check: PASSED

- FOUND: skills/gsd-atlas/SKILL.md, scripts/skills.test.ts, scripts/package.test.ts (modified), package.json (modified)
- FOUND commits: 4a50856, 5e82a4f
