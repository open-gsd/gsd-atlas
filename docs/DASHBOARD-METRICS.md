# gsd‑atlas — Dashboard metrics: showing the value atlas delivers, honestly

**Status:** Research · 2026‑10‑15 · companion to `DESIGN.md` A16, A18, A32, A50, A52, `AGENT-INTEGRATION.md` §4–§5, `DIAGNOSTICS.md` and the query‑and‑policy and tenant‑composition ADRs

The question: which numbers should an optional `gsd-atlas dashboard` show so a user can see what atlas is worth, and how can each be measured without fooling the user or the agent being measured? Constraints from the design: no telemetry, everything local in the store (A16); atlas must be the cheaper path (A32); evidence needs denominators and intervals (A50); anything that leaves the machine is a user‑approved diagnostics report (A52). Terms follow `GLOSSARY.md`.

Every external claim cites a primary source in §8. Claims not verified at a primary source are marked **unverified**.

---

## 1. Summary and recommendation

The main finding from comparable tools: **activity and acceptance counts are what vendors report, and they say themselves these are partial or conservative**; "time saved" is a multiplication of usage count by an assumed minutes figure (Sourcegraph); and a randomised trial found developers' perceived speed‑up was the opposite sign of the measured one (METR). So the dashboard should lead with things atlas can *measure* directly, label counterfactual savings as estimates with a range, and leave "productivity" claims to the A/B evaluation.

**Recommended headline metrics (eight):**

| # | Headline | Class | Why |
|---|----------|-------|-----|
| 1 | **Answers served and tokens delivered** (count, median and p95 tokens per answer, share within budget) | MEASURED | Pure fact; the cost side of A32. |
| 2 | **Lookups answered by atlas vs raw search** (with denominator: all search‑like tool calls seen by hooks) | MEASURED | Adoption. Honest because the denominator comes from the host's hook events, not from the agent's own report. |
| 3 | **Context kept out: bytes/tokens of files a grep or read sweep would have returned, minus what atlas returned** | ESTIMATED (method A, §3) with range | The "value" number users want, but it is counterfactual, so it is shown as a range and labeled. |
| 4 | **Problems caught before commit**: broken callers (R2/R4), SDK/API findings, syntax‑level findings, each split into *raised*, *fixed after warning*, *overridden*, *still open at commit* | MEASURED (raised, fixed, open); the "would have shipped" part is ESTIMATED | Outcome metric; the split stops "findings raised" being read as "bugs prevented". |
| 5 | **Gate behaviour**: fires, retries that passed, Stop blocks, user overrides, fail‑open events | MEASURED | Shows friction as well as value. Overrides are a precision proxy. |
| 6 | **Freshness**: p50/p95 lag from save to updated facts; `fresh_timeout` and stale‑answer rate | MEASURED | Trust in every other number rests on it. |
| 7 | **Atlas's own cost**: hook p50/p99, query latency, wall time and tokens spent on gates and retries, index CPU and store size against budget | MEASURED | Shown next to the savings, never hidden (A32 is a claim about net cost). |
| 8 | **Index health and answer quality**: parse‑error rate, files skipped, `degraded` rate, abstain rate, citation validity (share of cited spans that still resolve), user ↑ ↔ ↓ ratings | MEASURED | Honest accuracy without claiming correctness. Correctness itself is the A50 benchmark, not a live metric. |

An optional ninth panel, **A/B results** (hooks off / advise / enforce on the same tasks), appears only if the user ran `gsd-atlas eval`; it is the only place tokens‑to‑first‑correct‑edit or "tasks completed" may appear.

---

## 2. Metric catalogue

Class: **M** = MEASURED, **E** = ESTIMATED (counterfactual, method stated), **A/B** = needs the off/advise/enforce comparison. Gaming risk is about the *measured agent* (or a sloppy user script) moving the number without delivering value.

| Name | What it shows | How measured | Recorded by | Gaming risk | Privacy note |
|------|---------------|--------------|-------------|-------------|--------------|
| Answers served, by tool kind | Volume per `code_find`, `code_refs`, `code_context`, `code_impact`… | M | Query | High if shown as a goal: an agent can call tools needlessly. Show only with answer outcome and never as a target. | Counts only. |
| Tokens per answer, within‑budget share | Cost of atlas answers; A32 budget respected | M (counted on the final envelope text; state the tokenizer, which is an approximation unless the host reports usage) | Query | Low | Counts only. |
| Atlas vs raw search share | Adoption | M: Policy sees PreToolUse for Grep/Glob/`rg`/`find` (R1) and Query sees atlas calls | Policy (denominator), Query (numerator) | Medium: an agent can switch to atlas to look good, or to Bash variants that the matcher misses. Count unmatched shells as "unclassified" instead of dropping them. | Store pattern *class* (symbol‑like, text, path), not the pattern. |
| Raw‑search results atlas did not need to prevent (R1 attach/deny) | How often atlas had an exact answer when a raw search was attempted | M for events; savings from it are E | Policy | Medium | Class only. |
| Context kept out (tokens/bytes) | Counterfactual saving | E (§3) | Query computes inputs; Fact Store holds file sizes | High if used as a score: an agent can ask broad questions to inflate it. Count only answers the agent *then used instead of* a sweep (§3). | Sizes only, no paths unless hashed. |
| Broken callers caught | R2 context delivered before edits that change a signature; R4 blocks on removed symbols still referenced | M (events); "would have reached a commit" is E; ground truth only in A/B | Policy | Medium: an agent can avoid editing public symbols. Pair with edit throughput in A/B, not in the dashboard. | Hashed symbol key. |
| SDK/API findings (stale, invented, unavailable at target level) | `sdk_check` findings, split raised / fixed / overridden / open at commit | M; precision from user ratings and the hand‑verified sample (A50) | Query (finding), Policy (what the agent did next) | Medium: an agent can rewrite code to avoid APIs atlas covers. | Hashed SDK id and symbol key. |
| Syntax above language level | `syntax_check` findings by language level | M, same split | Query, Policy | Same | Same |
| Gate fires, retries that passed, Stop blocks (cap 3), overrides | Friction and precision | M | Policy | High for "fewer blocks = better": an agent might learn to stop at the first allow. Show blocks next to open findings at commit. | Counters. |
| Fail‑open events | How often a gate was open because atlas was `degraded` or down | M | Policy | None | Counters. |
| Freshness lag | Time from file save to `indexedThrough` covering it | M (event time at Indexer `submit`, commit time on the Fact Store watermark) | Indexer | Low | Durations. |
| `fresh_timeout` rate | How often `ensureFresh` timed out and the answer was stale | M | Indexer, Query | Low | Counter. |
| Citation validity | Share of cited spans that resolve to the current file content hash at answer time and still at session end | M (mechanical check, not truth) | Query, Fact Store | Low | Counters. |
| Abstain / degraded rate | Honest "don't know" share | M | Query | Medium: a good score for atlas by abstaining is cheap; show with answered share. | Counters. |
| User rating ↑ ↔ ↓ | Perceived usefulness | M (only the user can rate, per A52) | Host (CLI) | Not agent‑gameable by design (trust‑boundaries). Self‑report is biased (§4, METR). | Tool, outcome code, latency bucket only. |
| Hook overhead | p50/p99 hook time; timeouts | M (the host reports `duration_ms` on tool results; atlas times its own handler) | Host (adapter), Policy | Low | Durations. |
| Query latency | p50/p99 per tool against A50 budgets | M | Query, Governor (queue wait, `Busy` count) | Low | Durations. |
| Index CPU, memory, store size | Atlas's cost against A18/A41 budgets | M | Governor, Fact Store | Low | Sizes. |
| Parse‑error rate, files skipped, tier mix | Index health and coverage | M | Indexer, Fact Store | Low | Counts per language, no paths. |
| Tokens/tool calls to first correct edit; tasks done | Value outcome | **A/B** | `gsd-atlas eval` harness | Controlled by running the same fixed tasks | Local only. |
| Broken‑caller, invented API and syntax violations reaching a commit | End‑to‑end quality | **A/B**, plus M of the pre‑commit check result | Eval harness, `check --staged` | Controlled | Local only. |

---

## 3. Counterfactual methods for "tokens/context avoided"

The raw fact is only what atlas returned. What a grep or read would have cost is not observed, so it must be modelled, labeled **ESTIMATED**, and shown as a range.

**Method A: matched sweep size (static).** When an answer replaces a search‑like or read‑like need, compute from the Fact Store what the obvious raw action returns:
- `code_find`/`code_refs`: the sum of sizes (tokens, approximated as bytes/4 or a stated tokenizer) of *files that contain a match* (what an agent would read after `grep -l`), capped at the read limit the host applies per call; low bound = only the matching lines with 3 lines of context (what `grep -C3` prints).
- `code_context`/`code_impact`: sizes of the definition files plus the caller files, as a read‑all upper bound; the lower bound = the spans of the definition and call sites only.
- Estimate = raw‑action size − tokens atlas returned. Show `[low, high]`; the headline is the *low* bound.
- Error sources: the agent might have read fewer files (upper bound too high); an agent might do several greps (lower bound too low); file vs match granularity; tokenizer drift (±10–20 % by language; **unverified** figure, to be measured per corpus); atlas may be queried for something the agent would not have searched at all (savings of zero, counted as positive).
- Mitigation: only count an answer when the *next* tool call is not a raw search for the same symbol class (a "displaced sweep"), and report "answers counted / answers served" as the denominator.

**Method B: sampled shadow runs (empirical).** For a small random sample (default off, e.g. 1 in 50 eligible lookups, user opt‑in), atlas itself runs the raw alternative in the background (`rg`/file reads through the Command runner, same limits as a host would apply) and records only sizes. This replaces the sweep‑size *model* with an observed raw result for the same query.
- Error sources: the shadow action is atlas's guess of what the agent would have done; sampling variance (report a confidence interval, e.g. bootstrap over sampled lookups); extra CPU (counted in atlas's cost panel).
- Label: **ESTIMATED (sampled)**; improves method A's error bars by calibrating its ratio: `ratio = shadow_tokens / modelled_tokens`, reported with an interval, and applied to the non‑sampled lookups.

**Method C: A/B (not an estimate).** Hooks off vs advise vs enforce on the same task set (AGENT-INTEGRATION §5). The measured difference in total tokens and tool calls to the first correct edit is the only number allowed to be called a saving *attributable to atlas* for a task. The dashboard shows the last eval run with its date, task count, run count and interval. Anthropic's own guidance for evaluating agent tools likewise measures runtime, tool calls, token use and errors against tasks with verifiable outcomes (see §8).

**Method D (rejected): asking the agent.** An agent's own claim of "I saved N reads" is unverifiable and gameable.

**Labels:** `measured`, `estimated (model)`, `estimated (sampled, ±x)`, `A/B (n tasks, k runs)`. Never add an estimate to a measurement in one total.

---

## 4. What comparable tools report, and the pitfalls they document

| Tool | What it reports | Documented caveats | Source |
|------|-----------------|--------------------|--------|
| **Claude Code, OpenTelemetry** | Metrics: session count, lines of code, PRs, commits, cost, token usage by type (input, output, cache read, cache creation), edit‑tool accept/reject decisions, active time. Events: tool result (success, duration), tool decision, API request/error. | Cost is an estimate, not billing. `lines_of_code` and `active_time` are only briefly defined. Commits and PRs count only those made by Claude Code's own commands. `tool_result` is not emitted for rejected calls. Default 60 s export for metrics. Prompts and tool details are redacted by default, with separate opt‑ins for content. | [monitoring](https://code.claude.com/docs/en/monitoring-usage) |
| **Claude Code analytics dashboard** | Lines accepted, suggestion accept rate, active users, sessions, PRs with Claude Code, lines with Claude Code, leaderboard | The docs call the contribution metrics "deliberately conservative" (an underestimate); attribution matches PR lines to sessions within a window (21 days before to 2 days after the merge); code rewritten by more than 20 % is not attributed; "lines accepted" does not track later deletions; spend figures are estimates. | [analytics](https://code.claude.com/docs/en/analytics) |
| **GitHub Copilot usage metrics** | Lines changed with AI, agent contribution share, completion acceptance rate, agent adoption, code generation and acceptance counts | Acceptance undercounts (OS clipboard copy is not counted); generation events are not comparable to user interactions; CLI usage is excluded from dashboards; features overlap, so counts must not be summed; teams under five seats are excluded; credits are not billing totals. | [usage metrics](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics), [metrics API](https://docs.github.com/en/rest/copilot/copilot-metrics) |
| **Cursor analytics** | AI share of committed code, agent edits, Tab suggestions shown and accepted, messages, active users, per‑repo AI lines committed | AI share depends on diff signatures; formatters can invalidate them; CLI commits must be scored on the same machine; unattributable lines are "Other". Acceptance is reported as counts, not a defined rate. | [Cursor analytics](https://cursor.com/docs/account/teams/analytics) |
| **Sourcegraph** | Search and navigation activity, "Precise Code Nav %", Cody completions acceptance rate and persistence, latency, and an overall **"Total hours saved"** | Time saved is an estimate (count × minutes per use; e.g. 5 min per search, 2 min per accepted completion); the page does not say how the minutes were derived; a blank can mean no tracked activity; some counts are VS Code only. | [Sourcegraph analytics](https://sourcegraph.com/docs/analytics) |
| **OpenTelemetry GenAI conventions** | Metrics for operation duration, time to first token, agent duration, inference calls and tool calls per agent invocation, tool execution duration | All nine metrics on the page I read are in **Development** status (not stable). `gen_ai.client.token.usage` was not in that page; its status is **unverified**. | [GenAI metrics](https://github.com/open-telemetry/semantic-conventions-genai) (docs/gen-ai/gen-ai-metrics.md) |
| **DORA** | Change lead time, deployment frequency, failed deployment recovery time, change fail rate, deployment rework rate | Mandated targets invite gaming (the page cites Goodhart's law); use several metrics with tension between them; do not compare unlike teams or rank them; over‑investing in precise collection can delay improvement. | [DORA metrics](https://dora.dev/guides/dora-metrics/) |
| **SPACE** | Five dimensions: satisfaction and well‑being, performance, activity, communication and collaboration, efficiency and flow | The abstract says productivity cannot be captured by a single metric or dimension, or by activity alone. Specific recommendations (for example, how many dimensions to combine) are **unverified**: the full text could not be fetched (HTTP 403). | [ACM Queue](https://queue.acm.org/detail.cfm?id=3454124), [Microsoft Research](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/) |
| **METR randomised trial (2025)** | Measured completion time with vs without AI tools on 246 tasks | Developers forecast a 24 % speed‑up and later believed 20 %; measured: **19 % slower**. Perception is not a measurement. One small study (16 developers, mature repos), not a general law. | [arXiv 2507.09089](https://arxiv.org/abs/2507.09089) |

**What this means for atlas:**
- Everyone reports activity (counts, lines, accepts); nobody gives a measured "tokens saved". The closest, Sourcegraph's hours saved, is a stated multiplication, which is exactly what §3 labels as an estimate.
- Attribution‑style metrics are labeled "conservative" or "approximate" by their owners. Atlas should use the same wording for its estimates.
- Perception can mislead (METR), so ratings (↑ ↔ ↓) stay a separate panel and never feed a savings number.
- Cardinality and privacy: Claude Code lets operators choose per‑session or per‑account labels and redacts content by default. Atlas stores no such labels locally: aggregation is per Tenant and per day.

---

## 5. Goodhart and gaming analysis; honesty rules

The measured agent is the thing most likely to be affected by a number it can see (its own context includes `atlas_status` output). Goodhart's law is cited by DORA's guidance on targets (§4); I did not verify the original source of the aphorism (**unverified**, not needed for the design).

**Vulnerability by metric:**

| Metric | How it can be gamed | Mitigation |
|--------|---------------------|------------|
| Answers served / atlas share | Needless calls; shifting to unmatched shell forms | Do not put counts in the agent‑visible brief. Count unclassified shells in the denominator. Never expose as a goal. |
| Context kept out | Broad queries inflate the model | Count a saving only when a sweep was displaced (§3); cap per answer by the read limit; show the low bound. |
| Findings raised | Agent can ignore, or write code that avoids the checks | Report *open at commit* from the pre‑commit `check --staged`, which the agent does not control. |
| Fewer gate fires / blocks | Agent stops early or edits less | Show next to open findings at commit and edits per session. |
| Overrides | Only the user can override (A35, A44), so agent‑proof; but user habit can inflate | Show overrides as precision signal, never as a goal. |
| Abstain rate | Abstaining raises "no wrong answers" | Show answered share and abstain rate together. |
| Ratings | Only the user can rate | Keep apart from savings. |

**Honesty rules:**
1. **Label every figure** MEASURED, ESTIMATED (with method and interval) or A/B (with n). No unlabeled number.
2. **No single score.** There is no "atlas value score". SPACE and DORA both warn against one metric (§4).
3. **Show denominators** next to every ratio (for example "412 of 1,030 search‑like calls").
4. **Show atlas's own cost** in the same view as the savings: hook time, tokens of gate retries, CPU, store size.
5. **Show the low bound** of any estimate as the headline.
6. **Agent‑visible vs user‑visible:** the dashboard reads the store; `atlas_status` for the agent carries only health (watermark, degraded), not value statistics.
7. **Measure outcomes outside the agent's control** where possible: pre‑commit and CI results, hook events from the host, file sizes from the Source Tree.
8. **No comparison across users, repos or Tenants.** Each Tenant's numbers are its own (DORA warns against ranking).
9. **Report what is missing:** hosts without session ids run advise only (query‑and‑policy ADR); show "gates not enforced on this host" instead of zeros.

---

## 6. Data model sketch

Local, in the Tenant's Fact Store (separate tables from facts, same single‑writer rule: the Indexer is the only writer client for facts; metrics tables are written through the same store interface, batched). Nothing here is sent anywhere; the diagnostics catalog (A52) may offer *aggregates* of these tables as a data type, which the user approves per type.

**Event record (bounded ring, default 30 days or 50,000 rows, whichever is smaller):**

| Field | Notes |
|-------|-------|
| `ts` (minute resolution) | Coarse to limit re‑identification. |
| `kind` | `answer`, `gate`, `finding`, `override`, `fresh`, `hook`, `index_error`, `shadow`. |
| `session_hash`, `agent_hash` | Random per‑session, not host ids. |
| `tool`, `rule`, `outcome` | Enums. |
| `tokens_out`, `latency_ms`, `queue_ms` | Numbers. |
| `symbol_key_hash`, `path_hash` | Salted per‑store hash; **off by default**, enabled for `explain`‑style debugging only. |
| `counterfactual_low`, `counterfactual_high`, `method` | For estimates; method id ties to the §3 version. |

No source text, no prose, no patterns, no paths, no symbol names, no prompts (matches DIAGNOSTICS §1.5).

**Daily rollup (kept 13 months):** counters and histograms (fixed buckets) per day, per tool/rule/outcome/language: answers, tokens, latency buckets, gate counters, findings by split, freshness buckets, parse errors, atlas CPU seconds. Rollups are computed from events and are the source for the dashboard; events can then be discarded.

**Size and lifecycle (A18):** target at most about 1 MB per Tenant for events plus rollups, reported by `status` with the rest of the store; ring eviction instead of growth; `gsd-atlas status --reset-metrics` deletes the tables; deleting a Tenant deletes its metrics. Estimate sizes of this budget are **not measured yet** and should be set by the A50 benchmark.

**Where each is recorded:**

| Module | Records |
|--------|---------|
| Query | answer tokens, latency, degraded, abstain, citation checks, counterfactual inputs |
| Policy | gate fires, retries, Stop blocks, overrides, fail‑open, raw‑search events (R1), findings follow‑through. Its session ledger stays in memory (A37); only counters flow out at SessionEnd or on flush. |
| Indexer | freshness lag, `fresh_timeout`, parse errors, files skipped |
| Fact Store | size, integrity events, rebuilds |
| Governor | queue wait, `Busy` count, CPU and memory use |
| Host | hook transport timing, request counts (adapter level) |

**Failure rule:** metrics writes are best‑effort and never block an answer or gate (A36 fail‑open); a lost event is a lost event, and the rollup records a `dropped_events` counter so the dashboard can say so.

---

## 7. Dashboard shape

**CLI: `gsd-atlas status` (always) and `gsd-atlas dashboard --since 7d`:**

```
gsd-atlas · gsd-core · last 7 days          [all numbers local · none sent]
Health        index fresh to 12:04 · lag p95 180 ms · 0 stale answers · parse errors 0.3 %
Use           1,030 search-like calls · 412 answered by atlas (40 %) · 618 raw (text/config 71 %)
Cost of atlas answers 1,310 · median 640 tok · p95 1,900 · hook p99 14 ms · gate retries 2.1k tok
Context kept out  MEASURED: n/a   ESTIMATED (model, low bound): 1.2M tok [0.7M–2.9M] on 310/412 answers
Caught        broken callers: 9 raised · 7 fixed · 1 overridden · 1 open at commit
              SDK/API: 14 raised · 11 fixed · 2 overridden · 1 open  (user-rated ↑ 8 ↔ 2 ↓ 1)
              syntax-level: 5 raised · 5 fixed
Gates         fires 48 · retries passed 41 · Stop blocks 3 · overrides 2 · fail-open 6
Last A/B      (none run)  ·  run: gsd-atlas eval
```

**Local HTML view (`gsd-atlas dashboard --html`, served from the Host on the loopback address, no external assets):** same panels as small multiples over time (daily rollups), a table per tool and rule, each estimate with its interval and a "how is this estimated" link to §3's method text, a toggle between low bound and range, and an "export aggregates" button that only writes a local file or opens the diagnostics preview (A52). No third‑party scripts or fonts, to keep A16 true.

**Explicitly NOT shown:**
- a single value score, grade or "hours saved" figure;
- estimates added to measurements, or "tokens saved" without a label and interval;
- per‑agent or per‑user leaderboards (an agent is not a person; ranking invites gaming);
- source text, paths, symbol names or prompts (hashed keys only in debug mode);
- productivity claims (time to complete, tasks done) outside an A/B result;
- anything from another Tenant, or any telemetry upload.

---

## 8. Open questions and sources

**Open questions**
1. Tokenizer: can the host report real usage per tool result? If not, bytes/4 is the stated approximation and its error (per language) must be measured on the A50 corpora.
2. How should "displaced sweep" be detected for hosts without hooks (Cline‑style rules only)? Probably: not at all, so the estimate is hidden for those hosts.
3. Shadow runs (Method B): is the extra work acceptable to users, and should it be off by default? Proposed: off.
4. Should the `check --staged` result be recorded by the pre‑commit hook as a metric source ("open at commit")? It is the best outcome signal that the agent cannot influence, but git hooks exist outside the Host process model.
5. Retention defaults (30 days events, 13 months rollups) are guesses; set them from store size once measured.
6. Whether any aggregates are worth offering as an A52 diagnostics data type (privacy review needed; nothing is proposed here).
7. Align metric names with OpenTelemetry GenAI naming where useful (for a later local OTLP export that the user turns on themselves); the conventions are still in Development status, so do not depend on them.

**Could not verify at a primary source (unverified):**
- SPACE's detailed recommendations (full article returned HTTP 403; only the abstract‑level claim was confirmed).
- The OpenTelemetry `gen_ai.client.token.usage` metric and its stability.
- Cursor's definition of an "acceptance rate" (the page reports counts only).
- GitHub's "Reconciling Copilot usage metrics across dashboards, APIs, and reports" page (not read).
- The original source of Goodhart's law and the tokenizer error range of ±10–20 % (an assumption to be measured).
- Parts of Claude Code's hooks and monitoring pages beyond the first 100 to 200 thousand characters were not read.

**Sources**
- Claude Code: [monitoring (OpenTelemetry)](https://code.claude.com/docs/en/monitoring-usage), [analytics](https://code.claude.com/docs/en/analytics), [hooks](https://code.claude.com/docs/en/hooks) (PostToolUse `tool_response` and optional `duration_ms`; Stop `stop_hook_active`)
- GitHub: [Copilot usage metrics](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics), [Copilot metrics REST API](https://docs.github.com/en/rest/copilot/copilot-metrics)
- Cursor: [team analytics](https://cursor.com/docs/account/teams/analytics)
- Sourcegraph: [analytics](https://sourcegraph.com/docs/analytics)
- OpenTelemetry: [GenAI semantic conventions repository](https://github.com/open-telemetry/semantic-conventions-genai) (moved from [opentelemetry.io](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/))
- DORA: [DORA metrics guide](https://dora.dev/guides/dora-metrics/)
- SPACE: Forsgren, Storey, Maddila, Zimmermann, Houck, Butler, [The SPACE of Developer Productivity, ACM Queue 19(1)](https://queue.acm.org/detail.cfm?id=3454124)
- METR: [Measuring the impact of early‑2025 AI on experienced open‑source developer productivity](https://arxiv.org/abs/2507.09089)
- Anthropic: [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Repo: `DESIGN.md` A16, A18, A32, A33–A38, A50, A52; `AGENT-INTEGRATION.md` §4 (local metrics), §5 (evaluation); `DIAGNOSTICS.md` §1; `adr/draft-query-and-policy.md`; `adr/9-tenant-composition.md`; `GLOSSARY.md`
