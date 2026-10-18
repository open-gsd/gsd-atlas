# ADR: User‑controlled diagnostics, ratings and defect forensics

- **Status:** Proposed
- **Issue:** to be opened (rename to `<issue#>-user-controlled-diagnostics.md`)
- **DESIGN.md:** A16, A52
- **Supersedes:** the opt‑in `gsd-atlas report` idea in the product‑boundary ADR (review finding P‑3)

## Context
gsd‑atlas is privacy‑first: no network and no telemetry by default. That leaves the team blind to whether it works for anyone but its authors: which budgets fail on real machines, which features help, which annoy. The goal is real feedback without collecting anything the user hasn't read and approved.

## Decision
1. **No telemetry.** Diagnostics are a report the user builds, reads and submits; disabled by default.
2. **Consent per data type.** Fields are grouped into data types: Report header, Platform, Agent setup, Languages and index quality, Scale profile, Performance, Reliability, Agent behaviour, Ratings, Notes. A published catalog documents each type: its fields with examples, a full explanation of how it helps the project, and what it can't reveal.
   - Enabling walks through each type, showing the real values from the user's machine.
   - Every type starts denied; the user approves, denies or sets "ask each time" per type.
   - A new type, or a new field in an approved type, stays off until the user re‑approves it.
3. **Never collected:** source, paths, file/symbol/repo/branch names, remotes, commit hashes, doc or ADR text, prompts, transcripts, environment, usernames, hostnames, IPs. Sizes and counts are bucketed.
4. **Ratings ↑ ↔ ↓:** worked, meh (worked but not impressed), didn't work. They apply to a session, a feature or the last answer (tool, outcome code and latency bucket only). Ratings come only from the user; agents can suggest but never submit.
5. **Submission as GitHub issues** under the user's own account: via the user's `gh` CLI or a pre‑filled issue page. gsd‑atlas never holds a GitHub token. The flow states up front that issues in a public repo are public.
6. **Automatic submission** is a separate opt‑in (weekly or monthly). It sends approved types only, never Notes or ask‑each‑time types, keeps a local copy of each report, and is visible in `status` and the session brief.
7. **Repo‑side intake bot** (GitHub Actions, default token only):
   - validates reports against the catalog;
   - redacts non‑catalog content;
   - records valid reports without issue numbers or authors;
   - routes budget breaches, crash signatures and ↓ ratings to labelled issues;
   - posts a weekly roll‑up;
   - closes processed issues;
   - honours `/withdraw`.
8. **Only user‑level config** can enable diagnostics or auto‑submit (trust‑boundaries ADR).
9. **Defect forensics (`gsd-atlas bug`).**
   - **Flight recorder:** a capped, local‑only ring buffer of recent events per tenant (tool calls with argument shapes, outcomes, index and maintenance events, hook decisions, errors, crash stacks inside gsd‑atlas).
   - **Capture:** `gsd-atlas bug` collects the problem statement, versions and effective config, store and host health, a flight‑recorder excerpt, the failing answer with `explain`, and an optional minimal repro.
   - **Approval:** each forensic data type is approved by the user, with names and paths **hashed** by default (redacted or raw on explicit choice).
   - **Destination:** a public issue using the repo's bug form, a private security report, or a local bundle.
   - **Intake:** the workflow validates, routes, deduplicates by signature, asks for missing details, and never auto‑closes a defect.

## Consequences
- The team gets real‑world budget, platform and satisfaction data with explicit consent for every value.
- Reports are public and tied to a GitHub account; users who don't want that simply don't enable it. There is no anonymous channel, because there is no server.
- The catalog becomes a maintained, versioned artifact; adding a field needs a catalog bump and a documented reason.
- Volume will be low; the data guides priorities, it doesn't replace the evals.

## Alternatives considered
- **Conventional opt‑out telemetry:** violates the privacy stance.
- **Opt‑in telemetry to a hosted endpoint:** needs a server and trust in it; consent is all‑or‑nothing.
- **Free‑form bug reports only:** no consistent data to aggregate; no way to check budgets across machines.
- **Thumbs up/down only:** loses the most useful signal, "it worked but wasn't better" (↔).
