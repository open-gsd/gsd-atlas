# ADR: Local value dashboard and honest metrics

- **Status:** Proposed
- **Issue:** to be opened (rename to `<issue#>-value-dashboard.md`)
- **DESIGN.md:** A16, A18, A32, A36, A50, A52, A63
- **Research:** [DASHBOARD-METRICS.md](../DASHBOARD-METRICS.md)
- **Refines:** `AGENT-INTEGRATION.md` §4 "Local metrics", [12-query-and-policy](12-query-and-policy.md), [9-tenant-composition](9-tenant-composition.md)

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
