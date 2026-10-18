# ADR: Local value dashboard and honest metrics

- **Status:** Accepted
- **Issue:** [#14](https://github.com/open-gsd/gsd-atlas/issues/14)
- **Ratified:** 2026-10-16
- **DESIGN.md:** A16, A18, A32, A36, A50, A52, A63
- **Research:** [DASHBOARD-METRICS.md](../DASHBOARD-METRICS.md)
- **Refines:** `AGENT-INTEGRATION.md` §4 "Local metrics", [12-query-and-policy](12-query-and-policy.md), [9-tenant-composition](9-tenant-composition.md)

> Pre-release note: this record is not yet ratified; ratification is planned for the end of Phase 3, and every ADR will have a number by the MVP release; its Accepted status and issue number do not mean it is ratified (see docs/adr/README.md).

## Context
A32 says atlas must be the cheaper path, but nothing lets a user see whether it is. Comparable tools report activity and acceptance counts; none reports a measured "tokens saved" (Sourcegraph's "hours saved" is a usage count times an assumed minutes figure), and a randomised trial found developers believed they were faster while measuring slower (research §4). Atlas has three constraints that rule out the usual answers: no telemetry (A16), a measured agent that can read its own context and could game a visible number (research §5), and a store that is derived and rebuilt on corruption (A17), which suits facts but not metrics, since a metric cannot be re-derived from source.

## Decision
1. **Two surfaces, both local.** `gsd-atlas status` always shows a basic panel set; `gsd-atlas dashboard [--since 7d] [--html]` shows the full set. Nothing is sent anywhere. Aggregates leave the machine only through an A52 diagnostics report the user approves per data type; no aggregate is proposed as a data type here.
2. **A Metrics module per Tenant,** with its own small database file (`metrics.db`) beside the store, not tables in the Fact Store. Metrics are not derivable, so a Fact Store rebuild or `corrupt` move-aside must not lose them. The file is deleted with its Tenant; `gsd-atlas status --reset-metrics` deletes it on request.
3. **Interface:** `record(event)`, `report(range) → DashboardReport`, `reset()`.
   - `record` is best-effort. It uses a bounded in-memory queue, never blocks, never throws and never fails an answer or a gate (A36). Drops increment a `dropped_events` counter that the dashboard shows.
   - Two adapters: SQLite, and a no-op for when metrics are off. Tests use the SQLite adapter on a temp dir.
4. **Who records what:** Query (answers, tokens, latency, degraded, abstain, citation checks, counterfactual inputs); Policy (gate fires, retries, Stop blocks, overrides, fail-open, raw-search events, finding follow-through); Indexer (freshness lag, `fresh_timeout`, parse errors, files skipped); Fact Store (size, rebuilds); Governor (queue wait, `Busy`, CPU, memory); Host (hook timing). Policy's session ledger stays in memory (A37); only counters flow out.
5. **Event and rollup records hold no source text, prose, patterns, paths, symbol names or prompts.** Timestamps have minute resolution, session and agent ids are random per-session hashes, and path and symbol hashes are salted per store and off by default (debug only). Events are a bounded ring; daily rollups (counters and fixed-bucket histograms) feed the dashboard.
6. **Every figure carries a class:** `measured`, `estimated (model)`, `estimated (sampled, ±x)` or `A/B (n tasks, k runs)`. The report type makes the class mandatory and cannot add values of different classes into one total.
7. **Honesty rules, enforced in the report builder:** no single value score; a denominator beside every ratio; atlas's own cost (hook time, gate-retry tokens, CPU, store size) in the same view as the savings; the low bound of an estimate is the headline; no comparison across users, repos or Tenants; a host that cannot enforce gates shows "gates not enforced on this host", not zeros.
8. **Headline panels (eight):** answers and tokens delivered; atlas vs raw search share; context kept out (estimated, range); problems caught before commit, each split into raised / fixed after warning / overridden / still open at commit; gate behaviour; freshness; atlas's own cost; index health and answer quality (including user ratings). An optional ninth panel shows the last `gsd-atlas eval` A/B result; tokens-to-first-correct-edit and tasks completed appear only there.
9. **Counterfactual methods:**
   - **A, matched sweep size** (default): the size of the raw action an answer displaced, minus what atlas returned, counted only when the next tool call is not a raw search for the same symbol class; shown as `[low, high]`.
   - **B, sampled shadow runs:** atlas runs the raw alternative for a small sample and records sizes only, to calibrate A. Off by default; opt-in per user; runs through the CommandRunner.
   - **C, A/B:** hooks off / advise / enforce on the same tasks via `gsd-atlas eval`; the only figure that may be called a saving attributable to atlas.
   - Asking the agent how much it saved is rejected.
10. **Agent-invisible value statistics.** `atlas_status` and hook briefs carry health only (watermark, degraded); value statistics are never placed in agent context.
11. **Outcomes outside the agent's control are preferred:** pre-commit / CI `check --staged` results, hook events from the host, file sizes from the Source Tree.
12. **The HTML view is a generated, static, self-contained file** written by the CLI (no scripts or fonts from outside, A16). The Host serves no dashboard route, so A27's rejection of browser-style requests stays intact. It is a read-only report, not a GUI.
13. **Provisional retention:** events 30 days or 50,000 rows, rollups 13 months, about 1 MB per Tenant. These are guesses to be replaced from A50 measurements.
14. **Not shown:** a single score or grade; "hours saved"; estimates added to measurements; per-agent or per-user leaderboards; source text, paths, symbol names or prompts; productivity claims outside an A/B result.

## Consequences
- Users can see net value and net cost in one view, with an uncertainty range and a label on every number.
- The value statistics are hard for the measured agent to game, because they are not in its context and the key outcomes come from the pre-commit check, host hook events and the Source Tree.
- A new module, a second database file and a best-effort write path in four existing modules. Recording is a one-line `record(event)` call, so the cost to those modules is small.
- Estimates will look small and wide. That is deliberate: the headline is the low bound.
- A/B results need the evaluation harness, so that panel is empty until a user runs it.

## Alternatives considered
- **One "atlas value score":** easy to read, but SPACE and DORA both warn against single metrics, and it invites gaming.
- **Hours-saved multiplier (count × assumed minutes):** what Sourcegraph reports; an assumption presented as a result.
- **Ask the agent how much it saved:** unverifiable and gameable.
- **Metrics tables in the Fact Store:** simpler wiring, but a rebuild or corruption recovery would wipe them, and the single-writer rules for facts would constrain a different workload.
- **Opt-in telemetry upload:** forbidden by A16; the A52 diagnostics path is the only way data leaves.
- **Serve the HTML view from the Host:** needs an exception to A27.

## Open questions
- Can the host report real token usage per tool result? If not, bytes/4 is the stated approximation, and its per-language error must be measured on the A50 corpora.
- How is a displaced sweep detected on hosts with no hook bus (rules-only hosts)? Likely not at all, so the estimate is hidden there.
- Should the pre-commit hook record "open at commit" into `metrics.db`? It is the best outcome signal the agent cannot influence, but git hooks run outside the Host process.
- Should the OpenTelemetry GenAI names be aligned for a later local OTLP export? The conventions are still in Development status, so nothing depends on them yet.

## Amendment 2026-10-16: Metrics migrations and retention

Sources: FND-12; 02-CONTEXT.md D-17; 02-RESEARCH.md Pattern 13.

Phase 2 builds the Metrics module. These points settle what the decisions above left provisional. The original text stands unedited.

1. **Where the database lives (decision 2).** Metrics owns `metrics.db` beside the fact store, not inside it, so a store rebuild or a corruption move-aside never loses it.
2. **Forward-only migrations.** Schema changes are numbered, forward-only migrations keyed by `PRAGMA user_version`, each run in one transaction when the database is opened. A database whose `user_version` is newer than the code disables recording instead of failing an answer, in line with decision 3's rule that recording never fails an answer.
3. **Recording (decision 3).** `record` is a bounded in-memory queue that never blocks or throws. Events dropped when the queue is full are counted in `dropped_events`, which the dashboard shows.
4. **Events (decision 5).** Events are an allow-listed union: counters and histograms only, with hashed ids at most. Nothing outside the union can be recorded.
5. **Retention (decision 13).** Retention is 30 days rolling, with daily rollups made after 7 days. This replaces the provisional "events 30 days or 50,000 rows, rollups 13 months".
6. **Token figures.** Token figures are serialized characters divided by four and are labelled estimates, as decision 6 requires.

## Amendment 2026-10-18: Ratings table

Sources: 03-CONTEXT.md D-16; 03-RESEARCH.md Pattern 9 and Seam Gap G9; SKL-02; [13-mcp-contract](13-mcp-contract.md) and [12-query-and-policy](12-query-and-policy.md), amendments of the same date.

Phase 3 lets a user rate an answer, and the headline panel "index health and answer quality (including user ratings)" in decision 8 needs somewhere to read those ratings. The decisions above stand unedited; where this section is more specific, it governs.

1. **A ratings table, added by a migration.** Metrics gains a ratings table in `metrics.db` through one more forward-only, numbered migration under the rule of the amendment of 2026-10-16, so an older database is upgraded when opened and a newer one disables recording instead of failing an answer. A rating is an allow-listed event kind in the sense of decision 5 of the amendment of 2026-10-16: nothing outside the closed event union can be recorded.
2. **A closed vocabulary and no free text.** A row holds a scope, a subject, a value and a minute-resolution time. The scope is one of `answer`, `feature` and `session`. The subject is, by scope, an answer id (the random `answer_id` of the answers envelope, which holds no content), a feature name from a closed list (the tool names plus `skill`, `build` and `init`), or the random session id of the current host start. The value is one of `up`, `meh` and `down`. Each subject is validated against its pattern or list before it is stored, and a value outside the closed set is refused. This keeps decision 5 true: no source text, prose, path, symbol name or prompt is stored.
3. **No `note` text is ever stored.** The ratings table has no free text column, and the CLI has no note option in this phase. If a note is ever wanted, that is a separate decision with its own amendment, and the text still does not land in `metrics.db`.
4. **Who writes.** Only the CLI command that rates writes a row, on the user's request. There is no MCP rating tool, because users rate answers and agents do not; decision 10 (value statistics are never placed in agent context) is unchanged. A write on a read-only database reports that the rating was not saved and does not crash.
5. **Consumption is Phase 8.** Phase 3 stores ratings. The dashboard panel that reads them, with its denominator beside each ratio (decision 7), is built in Phase 8; until then ratings are only rows in the database and the dashboard shows none.
