# Diagnosis of the scored eval run (plan 03-35)

The registered verdict is **MVP not met** (`docs/eval/analysis.md`, line `OVERALL: MVP not met`). This file is the diagnosis the plan requires on a miss. It is descriptive: it explains where the numbers came from and proposes what a new registered run could change. Nothing here changes the verdict, a registered file, a parameter, a question or a result row (Deviations policy of `docs/eval/preregistration.md`). Phase 4 is blocked until a new registered run meets the gate (D-04).

What was measured, in the words of Revision 1: the atlas arm is the atlas tools together with the skill the model can see; the skill's tokens are billable tokens of the atlas arm and are never subtracted. The result is a result for `tools plus visible skill` and is not split between the two.

Source of every figure: the committed compact rows in `docs/eval/results/` (450 rows, 450 sessions with status `ok`, 0 failed, 0 retried, 0 contaminated), unless a subsection says otherwise. Sections 1 to 7 use rows only. Section 8 reads the raw per-session streams, which are not committed (they live outside the repository), and is marked as such. "Run-mean" means the mean of a question's three runs.

## The verdict, by criterion

| Criterion (registered rule) | Result | Met |
| --- | --- | --- |
| Accuracy: 5th percentile of the paired cluster bootstrap of (atlas minus grep) above -0.05 | atlas 0.8000, grep 0.7511, difference +0.0489, 5th percentile +0.0133 | yes |
| Tokens: 95th percentile of the paired bootstrap difference in billable tokens per session below zero (`upper-bound`) | atlas 47,375.1, grep 29,393.1 per session; paired difference +17,982.0, 5th percentile +15,435.1, 95th percentile +20,709.4 | no |
| Citations: point estimate of verifiable citations in the atlas arm at or above 0.80 (`point_estimate`) | 144 of 198 sessions, 72.7 percent (Wilson 66.1 to 78.5); 159 were needed | no |

The token miss is not a close call: the whole bootstrap interval is above zero, so atlas used more billable tokens, not fewer, under the point criterion as well. The citation miss is equally clear for the grep arm (146 of 198, 73.7 percent), so it is not a property of atlas.

## 1. Where the extra tokens come from

Mean per session (rows), atlas against grep:

| Usage kind | Atlas | Grep | Difference | Share of the 17,982 gap |
| --- | ---: | ---: | ---: | ---: |
| input | 6.9 | 6.9 | 0.0 | 0 percent |
| output | 661.1 | 652.7 | +8.4 | 0.0 percent |
| cache creation | 7,066.1 | 5,987.7 | +1,078.3 | 6.0 percent |
| cache read | 39,641.0 | 22,745.8 | +16,895.3 | 94.0 percent |
| billable (sum) | 47,375.1 | 29,393.1 | +17,982.0 | 100 percent |

- Cache reads are 83.7 percent of atlas billable tokens and 77.4 percent of grep's, and 94 percent of the gap. Cache reads are the registered "reported separately" column and are part of the billable total (D-06). Without them the atlas arm would still be higher, by 1,087 tokens a session (7,734 against 6,647, +16.3 percent).
- Tool calls per session are 3.75 for atlas and 3.50 for grep (including the final `StructuredOutput` call both arms make), so the gap is not mainly more turns. Per turn (a proxy: tool calls plus one), cache read is about 7,741 tokens for atlas against 4,567 for grep, and billable tokens are 9,315 against 6,023. The atlas context is about 3,200 tokens heavier on every turn.
- That per-turn weight is the fixed cost of the atlas arm: the seven tool definitions, the server instructions and the skill description. The plan 03-38 probe measured about +977 input tokens a turn for the skill description alone (`docs/eval/skill-visibility.md`); the remainder is not measured separately in this run and is attributed to the tool definitions and server instructions by inference.
- It is paid whether or not atlas is used. In the 139 pairs where the atlas session made no atlas tool call, atlas billable tokens were 46,644 against 27,761 for grep (ratio 1.68), and these pairs account for 64.9 percent of the total billable gap (2,624,702 of 4,045,947 tokens over the 225 pairs).
- Atlas used fewer billable tokens than grep in 15 of 225 pairs. Billable tokens per session at the 50th and 90th percentile and the maximum: atlas 34,731, 87,672, 214,416; grep 20,876, 52,555, 140,133.
- Cost (Claude Code's notional API-equivalent cost, not a charge): atlas 8.7419 USD, grep 7.3723 USD, ratio 1.19. The whole run cost 16.1142 USD notional.

## 2. Did atlas get used? (tool-call mix and the skill)

- An atlas tool was called in 86 of 225 atlas sessions (38.2 percent), 93 calls in all: `code_refs` 49, `code_find` 37, `code_impact` 7. `code_context`, `code_explain`, `atlas_status` and `lang_list` were called 0 times in 225 sessions. The `code_context` tool carries the `.cts` to `.cjs` emit mapping and `code_explain` the ADR citations, and both are categories of the registered question set.
- The skill body was loaded in 0 of 225 atlas sessions (`toolCallsByName.Skill` is absent in every row), as in the plan 03-38 smoke run and in every partial chunk. The model routed from the description alone. So the skill cost the atlas arm its description on every turn, and never its body.
- Atlas did not displace shell calls. Totals over the arm: `Bash` 522 (atlas) against 560 (grep), `Read` 3 against 2, plus the 93 atlas calls. That is 38 fewer shell calls for 93 atlas calls. In the 86 pairs where atlas was used, the atlas session made 4.02 tool calls against 3.76 for grep, and billable tokens were 1.52 times grep's (48,557 against 32,031).
- Accuracy relates to use as follows (descriptive, confounded by question type): atlas accuracy was 87.2 percent in sessions that called an atlas tool (n 86) and 75.5 percent in sessions that did not (n 139); grep accuracy on the same pairs was 82.6 and 70.5 percent. The two arms differ by about the same amount (4.6 and 5.0 points) in both groups, so the sessions that used atlas were not more accurate relative to grep than those that did not.

## 3. Per-category results

Rows grouped by the question's registered category (sessions per arm = questions x 3). Accuracy is the share of correct sessions; billable is the mean per session; "atlas calls" is the share of atlas sessions with at least one atlas tool call.

| Category | Questions | Atlas accuracy | Grep accuracy | Difference | Billable atlas | Billable grep | Ratio | Atlas sessions with an atlas call |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| callers | 17 | 72.5% | 68.6% | +3.9 pts | 55,649 | 39,660 | 1.40 | 18 of 51 (35.3%) |
| references | 8 | 75.0% | 75.0% | 0.0 pts | 31,826 | 17,098 | 1.86 | 9 of 24 (37.5%) |
| heritage | 8 | 100.0% | 100.0% | 0.0 pts | 36,125 | 19,898 | 1.82 | 1 of 24 (4.2%) |
| emit | 10 | 50.0% | 30.0% | +20.0 pts | 58,339 | 32,024 | 1.82 | 0 of 30 (0.0%) |
| adr | 10 | 90.0% | 83.3% | +6.7 pts | 41,953 | 24,980 | 1.68 | 3 of 30 (10.0%) |
| impact | 6 | 61.1% | 55.6% | +5.6 pts | 101,038 | 55,988 | 1.80 | 18 of 18 (100.0%) |
| definition | 7 | 100.0% | 100.0% | 0.0 pts | 27,387 | 19,382 | 1.41 | 12 of 21 (57.1%) |
| abstain | 9 | 100.0% | 100.0% | 0.0 pts | 29,181 | 21,407 | 1.36 | 25 of 27 (92.6%) |

- Atlas was dearer in every category, by 1.36 to 1.86 times. No category came close to parity.
- Atlas accuracy is at least grep's in every category. The largest difference is emit (+20.0 points on 10 questions), where atlas made no atlas call at all in 30 sessions. The accuracy gain there cannot be attributed to the atlas tools' output; the rows do not say whether it comes from the visible skill description and server instructions steering the model, or from noise in ten questions. This is an open question, not a finding.
- Abstain: both arms were correct in 27 of 27 sessions and neither fabricated an answer (0 `found` answers on abstain questions in either arm). Grep gave up (`not_found` on a question that has an answer) in 2 sessions, atlas in 0.
- Impact is the only category where atlas was always used (18 of 18) and it is the most expensive category in both arms (101,038 against 55,988).

## 4. Where the arms disagree

Questions whose run-mean accuracy differs (12 of 75). Ids and counts only; no answers or keys are copied here. Correct counts are out of three runs.

| Question | Category | Atlas correct | Grep correct | Atlas calls (3 sessions) | Billable atlas | Billable grep |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| q-003 | callers | 3 | 2 | 3 | 80,186 | 47,018 |
| q-006 | callers | 1 | 3 | 0 | 30,823 | 28,295 |
| q-023 | emit | 1 | 0 | 0 | 26,842 | 13,391 |
| q-025 | emit | 3 | 0 | 0 | 35,621 | 14,156 |
| q-026 | emit | 2 | 1 | 0 | 35,071 | 15,930 |
| q-038 | impact | 3 | 2 | 3 | 59,781 | 22,677 |
| q-039 | impact | 2 | 3 | 4 | 122,213 | 75,324 |
| q-053 | callers | 3 | 1 | 0 | 75,728 | 63,945 |
| q-054 | callers | 3 | 2 | 3 | 71,670 | 64,721 |
| q-063 | emit | 3 | 2 | 0 | 35,967 | 17,729 |
| q-067 | adr | 3 | 1 | 1 | 50,771 | 24,349 |
| q-070 | impact | 3 | 2 | 3 | 102,340 | 41,562 |

- Atlas is ahead on 10 of the 12 and behind on 2 (`q-006`, `q-039`). Session by session over the 225 pairs: both correct 166, only atlas correct 14, only grep correct 3, both wrong 42.
- The arms are wrong together on 13 questions in all three runs (`q-001`, `q-008`, `q-010`, `q-011`, `q-012`, `q-014`, `q-022`, `q-024`, `q-028`, `q-030`, `q-036`, `q-065`, `q-069`). That is 39 of the 42 both-wrong pairs and caps accuracy in both arms at about 83 percent. The pilot (`docs/eval/pilot.md`, Findings 7 and 8) found key and question defects that made both arms wrong together; whether any of these 13 is a key defect or a hard question was not examined here and is a candidate for review before a new registration.

## 5. Failure statuses

All 450 sessions finished `ok`: 0 timeouts, 0 budget stops, 0 errors, 0 kills, 0 failed sessions counted as incorrect, 0 infrastructure failures, 0 retries (450 attempts for 450 cells), 0 contaminated sessions. No rate-limit or usage-limit message appeared in the run log. The run is complete and gets a verdict.

## 6. Citations

Non-abstain sessions: 198 per arm. A session counts when it cites at least one file:line and every cited file:line verifies.

| Category | Atlas verifiable | Grep verifiable | Atlas with no line cited | Grep with no line cited | Atlas with a failed line | Grep with a failed line |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| callers | 43 of 51 (84.3%) | 47 of 51 (92.2%) | 8 | 4 | 0 | 0 |
| references | 24 of 24 | 24 of 24 | 0 | 0 | 0 | 0 |
| heritage | 24 of 24 | 24 of 24 | 0 | 0 | 0 | 0 |
| emit | 16 of 30 (53.3%) | 15 of 30 (50.0%) | 10 | 8 | 4 | 7 |
| adr | 11 of 30 (36.7%) | 11 of 30 (36.7%) | 16 | 9 | 3 | 10 |
| impact | 5 of 18 (27.8%) | 4 of 18 (22.2%) | 6 | 9 | 7 | 5 |
| definition | 21 of 21 | 21 of 21 | 0 | 0 | 0 | 0 |
| total | 144 of 198 (72.7%) | 146 of 198 (73.7%) | 40 | 30 | 14 | 22 |

- The shortfall is the same in both arms and sits in three categories: ADR (36.7 percent), impact (27.8 percent) and emit (53.3 percent). In the four others atlas is at 84 to 100 percent.
- Most missing citations are answers with no line at all (40 of the 54 non-verifiable atlas sessions); the answer schema makes `line` optional (only `file` is required), and 60 of the 75 keys are compared at file granularity, so a correct answer need not carry a line. Of 153 correct non-abstain atlas sessions, 34 were not verifiable; 25 incorrect sessions were verifiable.
- Over all cited lines in non-abstain answers, 90.8 percent verified for atlas and 94.2 percent for grep; the 14 atlas sessions with a failed line (22 for grep) each had at least one line that did not verify.
- At the question level, 15 of 66 non-abstain questions had no verifiable atlas session in three runs and 44 had three of three (grep: 14 and 45).
- This criterion therefore measures how the registered prompt and answer schema elicit lines as much as it measures atlas. Atlas result items carry `path` and `line` (seen in the sampled results), and the categories whose keys are about definitions, references and heritage are at 100 percent in both arms; the shortfall categories are those whose answers are files or documents without an obvious line (ADR, emit) and the set-valued impact answers. Which keys are line-granular was not cross-tabulated against this.

## 7. Candidate causes, ranked by evidence

1. **The fixed per-turn context of the atlas arm outweighs anything the tools save.** Evidence: 94 percent of the gap is cache read; the per-turn cache read is about 3,200 tokens higher; the 139 pairs with no atlas call account for 65 percent of the gap; atlas was dearer in every category and fewer tokens in 15 of 225 pairs. Strongest, and sufficient on its own to fail the registered criterion.
2. **Atlas calls added to the work instead of replacing it.** Evidence: 93 atlas calls against 38 fewer shell calls; in sessions that used atlas the tool calls rose (4.02 against 3.76) and the ratio to grep is still 1.52; impact sessions (100 percent atlas use) are 1.80 times grep. Several atlas answers are large (mean 4,656 bytes for `code_refs`, 7,700 for `code_impact`, with 24 of 93 calls truncated), so a call can cost more than the grep it replaces.
3. **Low and uneven routing to the tools.** Evidence: 38.2 percent use overall, 0 of 30 on emit, 1 of 24 on heritage, 3 of 30 on ADR questions, 4 of the 7 tools never called, the skill body never loaded. The skill description did not make the model reach for `code_context` or `code_explain`. Where the tools were not used they cost the atlas arm its fixed overhead and gave no information.
4. **Citations: the prompt and schema, not atlas.** Evidence: equal rates in the two arms (72.7 and 73.7 percent), no line cited in 40 sessions, three categories account for nearly all the shortfall.
5. **Precise tier coverage and empty results, only partly.** Evidence in section 8: 119 of the 277 tier-carrying result items came from the grammar tier, 32 of the 92 successful calls returned no results. This may explain some of the cases where the model fell back to grep after an atlas call. The rows alone cannot show it.
6. **Question and key quality is a separate question.** 13 of 75 questions were wrong in both arms in every run.

## 8. Raw-stream facts (not committed; counts only)

These come from the per-session streams of the atlas arm, kept outside the repository, because the rows do not hold tool results. They are descriptive and nothing in the verdict depends on them.

- Atlas tool results parsed: 93 (92 `ok`, 1 error, a `bad_cursor` from a malformed pagination cursor). 32 of the 92 successful calls returned an empty result list (34.8 percent). 24 of the 93 carried `truncated` and a `more` cursor.
- Result items: 365, with `confidence` EXTRACTED 242 and INFERRED 123, none marked ambiguous. Of the 277 items that carry a tier, 158 were `precise` (57.0 percent) and 119 `grammar` (43.0 percent).
- Mean result size: `code_find` 536 bytes, `code_refs` 4,656 bytes, `code_impact` 7,700 bytes.
- Permission denials (shell commands refused because a variable could not be checked): 5 in 5 atlas sessions and 16 in 9 grep sessions. They did not cause a failed session.
- Isolation check of all 450 streams: 0 mentions of `codegraph`, `memtrace`, `MEMTRACE-FIRST` or `GSD_MEMTRACE`, 0 system events of subtype `hook`, and 0 `hook_started` or `hook_response` events; the ten streams that contain the string `PreToolUse` do so only inside repository source text that a tool printed (a function name or a documentation path in the gsd-core source; none is a system event). The user's hooks were not loaded in any scored session (the harness passes `--setting-sources ""` and `--strict-mcp-config`).

## 9. Proposed iterations for a NEW registered run (proposals, not applied)

None of these may be applied to this result. Each would be a new registered run with its own approvals (Deviations policy), and Phase 4 stays blocked until such a run meets the gate (D-04).

1. **Cut the fixed footprint and measure it directly.** Shrink the seven tool schemas, the server instructions and the skill description, and measure the per-turn token difference with the one-turn probe method of `docs/eval/skill-visibility.md` before registering, so the token criterion is attacked where 94 percent of the gap sits. Consider exposing only the tools that were used (`code_find`, `code_refs`, `code_impact`) or listing tools lazily.
2. **Make an atlas call replace shell calls.** Return compact, citation-ready answers (file:line first, no padding), cap `code_refs` and `code_impact` payloads, and give the model a routing rule that one atlas call is enough where it applies, so that the shell call count falls rather than rises.
3. **Fix routing for the categories where atlas was never used** (emit, heritage, ADR): the description does not send the model to `code_context` or `code_explain`. This is a skill and tool-description change; it has to be decided before the next freeze and not tuned on this data's questions (D-23).
4. **Decide the citation design on purpose.** Both arms sit near 73 percent because lines are optional in the answer schema and most keys are file-granular. A new registration could require a line per item, or change which sessions count; either must be registered for both arms and approved by the user, since it changes the meaning of H3.
5. **Review the 13 questions wrong in both arms in every run** for key or question defects, with the oracle, before a new freeze, as the pilot did.
6. **Report the accuracy result as it is.** The accuracy criterion is met with a margin (5th percentile +1.33 points against the -5 point limit); a new run should keep that property while fixing tokens and citations.
