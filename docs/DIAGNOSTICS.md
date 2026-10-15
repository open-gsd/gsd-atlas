# gsd‑atlas — User‑controlled diagnostics, ratings and defect forensics

**Status:** Draft · 2026‑10‑15 · companion to `PRD.md` §11.2, `DESIGN.md` A52 and the user‑controlled‑diagnostics ADR

gsd‑atlas has **no telemetry**. What it has instead is a diagnostics report the user builds, reads and sends themselves, as a GitHub issue under their own account. Nothing is collected or sent unless the user turns it on, approves each **data type** after reading what it contains and how it helps, and then either submits a report or knowingly turns on automatic submission.

---

## 1. Principles

1. **Off by default.** A fresh install collects nothing beyond the local metrics `status` already shows, and sends nothing.
2. **Consent per data type, with a full explanation.** Fields are grouped into data types (Platform, Performance, Ratings, …).
   - Turning diagnostics on walks through every type. Each shows what fields it contains, the **real values from this machine**, how it helps the project in full, and what it cannot reveal.
   - Every type starts **denied**; the user approves types one at a time.
3. **New types and new fields are never auto‑approved.** The catalog has a version. A release that adds a type, or adds a field to an approved type, turns that type off until the user reviews and re‑approves it.
4. **The user sees exactly what is sent.** Every report is rendered locally first, byte for byte as it will appear in the issue. Automatic submission is a separate, explicit approval, and every sent report is kept in a local log.
5. **Never sent, in any type:** source code, file paths, file or symbol names, repo names, remotes or URLs, branch names, commit hashes, ADR or doc text, prompts or agent transcripts, environment variables, usernames, hostnames, IP addresses. Free‑text notes are the user's own words, shown for review and passed through redaction and path scrubbing before preview.
6. **Agents can't send or rate.** Only the user can enable diagnostics, approve types, submit reports or give ratings (trust‑boundaries ADR). The skill may *suggest* rating after a session; it can't submit one.
7. **No gsd‑atlas server.** Reports go to a GitHub repo as issues through the user's own GitHub account. Issues in a public repo are public and show the user's GitHub name; the enable flow says so before anything else.

---

## 2. Ratings: ↑ ↔ ↓

A three‑way rating, answered by the user in a few keystrokes:

| Symbol | Name | Meaning |
|--------|------|---------|
| **↑** | worked | It did what I needed. |
| **↔** | meh | It worked, but I wasn't impressed (slow, noisy, needed help, not better than before). |
| **↓** | didn't work | It failed, was wrong, or got in the way. |

**What can be rated:**
- a session;
- a feature (`code_find`, `code_context`, edit gate, `platform_card`, …);
- the last answer from a tool. The rating records the tool, outcome code and latency bucket, never the answer's content.

**How:**
- CLI: `gsd-atlas rate ↑|↔|↓` (or `up|side|down`), `--about session|<feature>|last`, optional `--note "…"`.
- A user‑invoked slash command from the skill (`/atlas-rate`).
- An optional prompt at session end, off by default.

Ratings are stored locally and included in a report only if the **Ratings** data type is approved.

---

## 3. Data types (catalog v1)

Every type below is approved or denied as a whole. Each lists its fields with an example, explains how it helps, and states what it can't reveal. Sizes and counts are fixed buckets, so exact numbers can't fingerprint a repo. The catalog file (`diagnostics/catalog.v1.json`) ships with gsd‑atlas and is published in the repo; the CLI and the intake bot both validate against it.

### 3.1 Report header (required to send anything)
| Field | Example |
|-------|---------|
| `atlas_version` | `0.3.1` |
| `catalog_version` | `1` |

**How it helps.** Every other number only means something next to the release that produced it. The version lets us tell a regression introduced in 0.3.1 from a problem that was always there, and the catalog version lets the intake bot check that the report contains only fields that release was allowed to send. Without it, a report can't be validated, so it can't be processed.
**Can't reveal:** anything about you, your machine or your code.

### 3.2 Platform
| Field | Example |
|-------|---------|
| `os_family` | `macOS` |
| `os_major` | `27` |
| `node_major` | `24` |

**How it helps.** gsd‑atlas depends on things that behave differently per platform: file watchers (FSEvents, inotify, Windows), Unix sockets versus named pipes, path and line‑ending rules, and `node:sqlite`, whose behaviour changes between Node versions. When a bug or a slow build clusters on one OS or Node version, we know where to look and which CI job is missing. It also tells us which platforms matter most, so testing effort follows real use.
**Can't reveal:** your machine name, user, hardware ID or location.

### 3.3 Agent setup
| Field | Example |
|-------|---------|
| `agent_host` | `claude-code` |
| `transport` | `unix-socket` |

**How it helps.** Hooks and MCP behave differently per agent host: which events exist, whether HTTP hooks work, whether session ids are provided. This tells us which hosts people actually use with atlas, where the enforcement design degrades to advise mode, and whether the zero‑process transport is being used or people fall back to the stdio shim. It decides which host integrations get attention first.
**Can't reveal:** your prompts, sessions, agent output or accounts.

### 3.4 Languages and index quality
| Field | Example |
|-------|---------|
| `languages_active` | `["typescript"]` |
| `tiers_active` | `{"typescript":["grammar","precise"]}` |
| `parse_error_rate` | `{"typescript":0.004}` |
| `degraded_rate` | `0.12` |

**How it helps.** This is how we find out whether atlas's answers are trustworthy on real code, not just on our test repos.
- **Parse error rate** shows grammar drift: new syntax the grammar doesn't understand yet.
- **Tiers active** shows whether the precise tier actually runs, or quietly falls back to name matching.
- **Degraded rate** shows how often answers came back incomplete because precise resolution wasn't available.

Together they tell us which language module to fix next and whether the memory budget for compilers is set right.
**Can't reveal:** which files failed, any code, or any names.

### 3.5 Scale profile
| Field | Example |
|-------|---------|
| `repo_count_bucket` | `2–5` |
| `repo_size_bucket` | `100K–500K LOC` |
| `worktree_count_bucket` | `6–20` |
| `agent_concurrency_bucket` | `51–200` |

**How it helps.** The design makes promises at scale: many repos on one host, many worktrees sharing one index, hundreds of concurrent agents. These buckets show whether real setups look like what we designed and tested for. They also put the performance numbers in context: a 30‑second build on a 1M‑line repo is fine; on a 50K‑line repo it's a bug.
**Can't reveal:** repo names, exact sizes or what the repos contain.

### 3.6 Performance
| Field | Example |
|-------|---------|
| `build_time_bucket` | `10–30 s` |
| `store_size_bucket` | `50–100 MB` |
| `query_latency` | `{"code_refs":{"p50_ms":3,"p95_ms":11}}` |
| `hook_latency` | `{"p95_ms":9}` |
| `budget_breaches` | `["store_size"]` |

**How it helps.** Every budget in DESIGN.md is a promise:
- query times;
- hook latency;
- store size (the reason Memtrace‑style multi‑GB stores won't happen);
- build time.

These fields check those promises on real machines instead of our CI containers. A budget breach points straight at the design decision that failed and the release that broke it, and store size catches growth long before it becomes a problem for anyone.
**Can't reveal:** what was queried or which files were built.

### 3.7 Reliability
| Field | Example |
|-------|---------|
| `error_codes` | `{"E_PARSE":3,"E_LOCK":1}` |
| `crash_signature` | `sha256:3f…`, `{"count":2}` |

**How it helps.** Error reason codes and counts show the commonest failures without any error messages, which can contain paths. A crash signature is a hash of the stack frames inside gsd‑atlas only, so crashes from different users that share a cause are grouped into one issue with a count. That turns scattered "it crashed" reports into a ranked list of real bugs.
**Can't reveal:** messages, paths, stack traces or anything outside gsd‑atlas's own code.

### 3.8 Agent behaviour
| Field | Example |
|-------|---------|
| `gate_stats` | `{"R2":{"fired":14,"retried":12,"overridden":1}}` |
| `atlas_vs_grep` | `{"atlas":420,"grep":35}` |

**How it helps.** The point of atlas is that agents stop guessing. These counts show whether agents actually choose atlas over grep, and whether the enforcement hooks help or just get in the way: a gate that fires often and is usually overridden is badly tuned. This is the evidence for deciding whether `enforce` should ever become the default.
**Can't reveal:** what the agents searched for, edited or said.

### 3.9 Ratings
| Field | Example |
|-------|---------|
| `rating` | `{"about":"code_context","value":"↔"}` |

**How it helps.** Numbers say whether atlas is fast and correct; ratings say whether it's *useful*. The middle value matters most: ↔ ("worked but not impressed") marks features that technically pass every test but don't earn their place. Ratings per feature show where to invest and what to simplify or cut.
**Can't reveal:** the answer that was rated or the code it was about.

### 3.10 Notes
| Field | Example |
|-------|---------|
| `note` | `"slow on first query after branch switch"` |

**How it helps.** A short note explains what the numbers can't: what you were doing, what you expected, what felt wrong. One sentence often turns a ↓ into a reproducible bug.
**Can't reveal** anything you don't write. Notes are redacted and path‑scrubbed, shown for review before every send, and never included in automatic submissions.

---

## 4. User flow

1. **Enable:** `gsd-atlas diagnostics enable`.
   - Explains: off by default; reports become public GitHub issues under your account; nothing is sent without your approval.
   - For each data type, shows its fields with the real values from this machine, the full "how it helps" text and the "can't reveal" text. Answers: approve, deny, or ask each time. Default: deny.
   - Saves choices to `~/.config/gsd-atlas/diagnostics.json` (user‑level only; a repo can never set this).
2. **Preview:** `gsd-atlas diagnostics preview` renders the exact issue title and body.
3. **Submit:** `gsd-atlas diagnostics submit` either:
   - uses the user's GitHub CLI (`gh issue create`) if installed and signed in, or
   - opens a pre‑filled new‑issue page in the browser for the user to post.

   gsd‑atlas never stores a GitHub token.
4. **Automatic submission (optional, separate approval):** `gsd-atlas diagnostics auto weekly|monthly`. It includes approved types only, never "ask each time" types or Notes, keeps a local copy of every report, and is shown in `status` and the SessionStart brief. `gsd-atlas diagnostics auto off` stops it.
5. **Review and revoke:**
   - `diagnostics history` lists every report sent, with links.
   - `diagnostics types` changes approvals at any time.
   - `diagnostics disable` turns everything off and deletes local unsent data.

   Sent issues can be closed or edited by the user on GitHub. The intake bot also honours a `/withdraw` comment by redacting the body and closing the issue.

---

## 5. Report format

- **Title:** `[diagnostics] atlas 0.3.1 · macOS 27 · ↔ code_context`
- **Labels:** `diagnostics`, `rating:up|side|down`, `os:<family>`
- **Body:** a short human summary, then one fenced JSON block (`diagnostics-v1`) containing only fields from approved types and the catalog version. Nothing else.

---

## 6. Repo‑side automatic processing

A GitHub Actions workflow (`diagnostics-intake.yml`) in the gsd‑atlas repo processes each issue labelled `diagnostics`:

1. **Validate** the JSON block against the catalog version named in it.
   - Any field not in the catalog, any value outside its schema (e.g. a path‑like string), or any text outside the block: the bot redacts the issue body to the valid fields, comments why, and labels it `diagnostics:invalid`.
   - Malformed reports are closed with an explanation.
2. **Record** valid reports as one line each in `diagnostics/data/<YYYY-MM>.jsonl` on a data branch (no issue numbers or usernames stored with them).
3. **Route** by content:
   - `budget_breaches` → `perf` label and the matching budget's tracking issue;
   - repeated `crash_signature` → one crash issue per signature, counted;
   - ↓ ratings with a note → `triage`.
4. **Roll up** weekly into a pinned summary (ratings per feature, budget breaches per release, top error codes, platforms).
5. **Close** the processed issue with a thank‑you and a link to the summary.
6. **Abuse limits:** at most a few reports per account per day are processed; duplicates are closed as duplicates.

The workflow has no secrets beyond the default `GITHUB_TOKEN`, runs only on the repo's own events, and never fetches anything from reports.

---

## 7. Local storage

- **Approved‑type choices:** `~/.config/gsd-atlas/diagnostics.json`.
- **Pending metrics and ratings:** `~/.local/state/gsd-atlas/diagnostics/` (Windows: `%LOCALAPPDATA%`), rolling 90 days, deleted on `disable`.
- **Sent reports:** a local copy of every report, kept until the user deletes it.

---

## 8. Acceptance tests

1. A fresh install sends nothing and stores no diagnostics data beyond `status` metrics.
2. Enabling with only the Report header approved produces a report containing only `atlas_version` and `catalog_version`, and nothing is submitted without a submit command or auto approval.
3. A field added to an approved type in catalog v2 turns that type off until the user re‑approves it; a new type is absent until approved.
4. A fixture repo whose paths, names and doc comments contain identifying strings and secrets produces a report containing none of them, including in the note after redaction.
5. A repo‑committed config that tries to enable diagnostics or auto‑submit has no effect.
6. The intake bot redacts a report carrying a non‑catalog field, closes a malformed one, and records a valid one without the issue number or author.

---

## 9. Defect forensics: `gsd-atlas bug`

Diagnostics show trends across many users. A defect needs the opposite: everything about one failure, detailed enough for a maintainer to reproduce it. `gsd-atlas bug` captures that into a GitHub issue under the same rules: nothing leaves the machine without the user reading and approving it, per data type.

### 9.1 Flight recorder (local only)
- The host keeps a small ring buffer of recent events per tenant: tool calls (tool, argument *shape*, outcome code, latency), index events, maintenance runs, hook decisions, errors with reason codes, and crash stacks inside gsd‑atlas.
- It is always local and capped (default 2,000 events or 5 MB per tenant), and is cleared on `diagnostics disable` or `bug --clear`.
- It's what lets a bug report describe what happened *before* the failure, which a user rarely remembers.
- On a crash, budget breach or integrity failure, `status` and the next SessionStart brief say "something went wrong; run `gsd-atlas bug` to report it".

### 9.2 Capture flow
1. **Start:** `gsd-atlas bug` (or `/atlas-bug` from the skill, user‑invoked only). It asks for:
   - what happened;
   - what was expected;
   - steps to reproduce;
   - an optional ↓ or ↔ rating for the feature involved.
2. **Collect.** The tool gathers each forensic data type (§9.3) locally and runs the self‑checks:
   - `quick_check` and schema version on the store;
   - host and tenant state;
   - grammar and compiler versions;
   - `explain` on the failing fact, if one was named.
3. **Approve per data type.** Same flow as diagnostics: every type shows its contents, how it helps fix the bug and what it can't reveal, and starts denied. Types that can contain repo details offer three modes: **hashed** (default), **redacted**, or **raw**.
4. **Preview** the exact issue, then choose where it goes:
   - **Public issue** on the gsd‑atlas repo (via `gh` or a pre‑filled issue page).
   - **Private security report** (GitHub private vulnerability reporting) for anything security‑related. The tool suggests it when the failure involves the trust boundaries.
   - **Save locally** as a bundle to share privately with a maintainer.
5. **Log:** every bundle sent or saved is kept locally until the user deletes it.

### 9.3 Forensic data types
Approved per type, like §3. Report header, Platform, Agent setup, Languages and index quality, Performance and Reliability (§3) can be reused as they are. These add the detail a defect needs:

#### Problem statement
| Field | Example |
|-------|---------|
| `what_happened`, `expected`, `steps` | user text |
| `feature`, `rating` | `code_refs`, `↓` |

**How it helps.** The user's description is the anchor everything else is read against; without "expected X, got Y" a maintainer is guessing what's wrong. **Can't reveal** anything the user doesn't write; redacted and path‑scrubbed before preview.

#### Versions and configuration
| Field | Example |
|-------|---------|
| `versions` | atlas, Node, `node:sqlite`/SQLite, grammar and module versions, TypeScript version in use |
| `config_effective` | user‑level config with secrets removed and paths replaced by placeholders |
| `policy_mode` | `advise` |

**How it helps.** Most "it doesn't work for me" bugs come down to a version or a setting the maintainer doesn't have. The effective config shows exactly which options were on, including permissions and budgets, so the maintainer can match the setup.
**Can't reveal:** tokens, secrets or real paths.

#### Store and host health
| Field | Example |
|-------|---------|
| `store_check` | `quick_check: ok`, schema version, page and free‑page counts |
| `store_counts` | facts, symbols, overlays, retired versions (counts only) |
| `host_state` | tenants loaded, queue depths, governor memory, transport, uptime, restarts |
| `maintenance_log` | last run and outcome of each maintenance task |

**How it helps.** Separates "atlas gave a wrong answer" from "atlas's store or host was unhealthy when it answered". Corruption, a stuck tenant, a full queue or a skipped Reconcile each explain whole classes of symptoms, and the counts show whether retirement and compaction kept up.
**Can't reveal:** any stored fact's content.

#### Flight recorder excerpt
| Field | Example |
|-------|---------|
| `events` | last N events before the failure: `{"t":"-4.2s","tool":"code_refs","args":{"symbol":"<h:9c1e>"},"outcome":"E_RESOLVE","ms":38}` |

**How it helps.** Shows the sequence that led to the failure: the edit, the branch switch, the query, the error. Maintainers can replay the same sequence against a test repo. This is usually the single most useful part of a defect report.
**Can't reveal:** in the default **hashed** mode, symbol names and paths appear only as stable hashes, so the sequence and repeats are visible without the names. Redacted mode drops them; raw mode shows them and is marked in the preview.

#### Failing answer
| Field | Example |
|-------|---------|
| `request` | the tool and arguments that gave the wrong answer |
| `response` | the envelope returned (citations, watermark, `degraded`) |
| `explain` | extractor, tier, grammar version, resolution context, overlay for the cited facts |

**How it helps.** A wrong reference or a missing definition is only fixable when the maintainer can see which extractor and tier produced it and what resolution context was used. `explain` turns "wrong answer" into "the grammar tier name‑matched because the precise tier was degraded for this overlay".
**Can't reveal:** in hashed mode, names and paths are hashed; the code itself is never included.

#### Minimal reproduction (optional)
| Field | Example |
|-------|---------|
| `repro_snippet` | a code snippet the user pastes or the tool proposes from the failing span |

**How it helps.** A ten‑line snippet that triggers the bug is worth more than everything else combined. The tool can propose the failing span with identifiers renamed (`fn_1`, `Type_2`), and the user edits it.
**Can't reveal** anything unless the user approves this type and the snippet in preview. It's always shown in full and off by default.

### 9.4 Issue format
- Uses the repo's bug issue form (`.github/ISSUE_TEMPLATE/bug.yml`), so the tool's sections match the fields a human would fill in.
- **Title:** `[bug] code_refs: <user's one‑line summary> · atlas 0.3.1 · macOS 27`
- **Labels:** `bug`, `forensic`, plus component labels from the failure (`store`, `host`, `module:typescript`, `hooks`).
- **Body:** the problem statement, then one collapsible `<details>` section per approved type, then a fenced JSON block (`forensics-v1`) with the structured data.
- **Size:** GitHub caps an issue body at about 65,000 characters, so the flight recorder excerpt is trimmed to fit, oldest first. The full bundle can be saved locally and shared privately.

### 9.5 Repo‑side processing
The intake workflow (§6) also handles issues labelled `forensic`:
1. **Validate** the `forensics-v1` block against the schema; redact anything outside approved types.
2. **Route** by component and error code; apply labels.
3. **Deduplicate** by crash signature or error code plus feature; link to an existing issue and add a counter instead of opening parallel threads.
4. **Ask for what's missing:** if no versions or no steps, comment asking for them (and how to add them with `gsd-atlas bug --amend`).
5. **Link** matching diagnostics trends (e.g. the same budget breach across releases).
6. **Never** close a forensic issue automatically; it stays open for a human.

### 9.6 Acceptance tests
1. With nothing approved, `gsd-atlas bug` produces only the user's own text and the report header.
2. In hashed mode, a fixture repo's symbol names, paths, branch names and secrets appear nowhere in the bundle; in raw mode they appear only after explicit approval and are marked in the preview.
3. The flight recorder never exceeds its cap and never leaves the machine except inside an approved bug report.
4. A crash, integrity failure or budget breach produces a prompt to run `gsd-atlas bug` in `status` and the next session brief.
5. The intake workflow deduplicates two reports with the same crash signature and asks for steps when they're missing.
