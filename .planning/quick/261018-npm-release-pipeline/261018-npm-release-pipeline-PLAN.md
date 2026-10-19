---
phase: quick-261018-npm-release-pipeline
plan: 01
type: execute
wave: 1
depends_on: []
autonomous: true
tdd_mode: true
requirements: [QUICK-261018-npm-release-pipeline]
files_modified:
  - scripts/release-check.ts
  - scripts/release-check.test.ts
  - .github/workflows/release.yml
  - .github/workflows/ci.yml
  - scripts/ci-config.test.ts
  - scripts/package.test.ts
  - scripts/docs-reference.test.ts
  - package.json
  - CHANGELOG.md
  - README.md
  - docs/reference/alpha-limitations.md
  - docs/reference/release-channels.md
  - docs/how-to/release-an-alpha.md

must_haves:
  truths:
    - "The pipeline publishes @opengsd/gsd-atlas to npm from GitHub Actions only; nothing in this task publishes, tags, pushes, changes visibility or touches a token."
    - "release.yml is workflow_dispatch only, dry_run defaults to true, three channels alpha | next | latest, the dist-tag equals the channel, and a prerelease can never reach latest."
    - "A real (non-dry) release is refused unless the ref is main and the repository is public."
    - "id-token: write is granted on the publish job only; top-level permissions stay contents: read."
    - "scripts/release-check.ts fails with one clear message per violated rule and exits non-zero."
    - "The CLI prints 0.1.0-alpha.0; docs say the alpha is installed with npm install -g @opengsd/gsd-atlas@alpha, promise no stable date, and keep the Windows sentence and the MVP-not-met status."
    - "Stage A/B and the committed analysis (scripts/eval, docs/eval, skills/gsd-atlas/SKILL.md) are untouched; verify-prereg prints ok."
  tasks:
    - "1 RED/GREEN: scripts/release-check.ts (channel and version rules, changelog, manifest, pack allow-list, secrets, size)"
    - "2 RED/GREEN: .github/workflows/release.yml, ci.yml release dry run, ci-config invariants"
    - "3 package.json 0.1.0-alpha.0, metadata, CHANGELOG.md, pinned-version tests"
    - "4 Docs via writing-docs-with-diataxis: README, alpha limitations, how-to, channel reference, verified against a packed tarball in a scratch prefix"
    - "5 SUMMARY.md with the manual checklist, dry-run evidence and open items"
---

# Quick task: npm release pipeline for the alpha

Objective: a verified pipeline (dry run and real release, channels alpha / next / latest) so the maintainer can publish
0.1.0-alpha.0 once the repository is public and npm is configured. The user does the manual setup.

Sources for the npm facts (fetched 2026-10-18): docs.npmjs.com trusted-publishers, generating-provenance-statements,
cli/v11/commands/npm-publish, cli/v11/commands/npm-trust, policies/unpublish; nodejs.org/dist/index.json for the npm
version bundled with Node 24.16.0 (11.13.0).
