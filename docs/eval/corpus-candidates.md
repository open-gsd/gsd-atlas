# Candidate corpora for the next eval (2026-10-21)

**Status: a research note. Nothing here is registered, scored or approved.** The registered verdict `OVERALL: MVP not met` stands and this note proposes nothing for the existing registered result. No decision record is described as ratified. Rankings and recommendations are the agent's judgement, labelled as such. No money was spent: no model session was run. Raw data: `docs/eval/corpus-candidates.json`. Tool: `scripts/corpus-survey/` (tests first: `lib.test.ts`, `survey.test.ts`).

## 1. Method (what was measured and how)

- **Checkouts.** `git clone --depth 1` of public repositories into the session scratchpad on 2026-10-21; the SHA is the clone's HEAD at that time (table in section 2). `gsd-pi` was fetched at its manifest pin `bb86b6ca2d3d047899092d845d574beeb5a21965` (`corpora/corpora.json`). The baseline `gsd-core` was exported with `git archive` from the local clone at `10ac3a7a947903ba50f538a907af036744d759d5` (the clone was not modified). No code from any clone was run: no install, build, script or test. Files were listed (`git ls-files`), read as text, parsed with this repository's `typescript` 6.0.3 (syntax only) and searched with ripgrep.
- **Name sample.** Eligible files: `.ts .tsx .mts .cts .js .jsx .mjs .cjs`, not `.d.ts`, not a test or fixture path (`isTestPath` in `lib.ts`). Sample: the 3,000 files with the smallest `sha256("20261017\0<path>")` (or all, when fewer are eligible). Exported names: `export function/class/const/let/var`, `export default function Name`, and CommonJS `module.exports = {...}`, `exports.x =`, `module.exports.x =`. Types and interfaces are not counted.
- **Grep cost proxy.** From the distinct exported names of length >= 3, 200 are drawn by the same hash rule (seed `20261017:grep`). Each is searched with `rg -w -F -c --no-ignore --hidden -g '!.git'` over the whole tree (tests, docs and generated files included). Reported: matching lines and files, median and 90th percentile, and the share of names with more than 20 matching files. **A second sample** uses only names exported from more than one sampled file (up to 200; `grepAmbiguous`), because a question author can choose such names and a random exported name mostly cannot be confused with another.
- **Resolution without install.** For up to 1,500 sampled files, each static import specifier is resolved with `ts.resolveModuleName` against the nearest tracked `tsconfig.json` (real file system, **no node_modules**). Specifiers are classed relative, workspace (a name found in a tracked `package.json`) or external.
- **gsd-core baseline** is measured by the same code, same seed and same rules (row 1 of every table).
- Heritage counts use a line-start regex for `class X extends/implements` in `.ts/.tsx` (an approximation, not a parse).

## 2. Candidates and pins

| id | repository | pinned SHA (clone HEAD, commit date) |
| --- | --- | --- |
| gsd-core (baseline) | open-gsd/gsd-core | `10ac3a7a947903ba50f538a907af036744d759d5` (registered) |
| gsd-pi | open-gsd/gsd-pi | `bb86b6ca2d3d047899092d845d574beeb5a21965` (manifest pin, 2026-10-15) |
| vscode | microsoft/vscode | `a403d0f7dcca0727353f838d89be6d7c682ea7c9` (2026-10-21) |
| TypeScript | microsoft/TypeScript | `98add1bbed1c814e97457587c2da407dc3f78330` (2026-10-21) |
| angular | angular/angular | `3cc1edf3210a9debb0be57a4e99e53a54505db32` (2026-10-21) |
| excalidraw | excalidraw/excalidraw | `1d4dc2c0e6e476911d0760e9c3cf3694f2d43384` (2026-10-21) |
| backstage | backstage/backstage | `53d5be17828fc558132aafd5b4b7d996480aa0f1` (2026-10-21) |
| n8n | n8n-io/n8n | `58f11bf0cf5e384efa7f6818fc940ff5ed8200a9` (2026-10-21) |
| nest | nestjs/nest | `62647d3ec95e816a4556b3e04106eb4af002b4b8` (2026-10-21) |
| vue-core | vuejs/core | `65eae178383289b6a9f93505ab85017460f72395` (2026-10-21) |
| material-ui | mui/material-ui | `2a8f217d7919d80d8760a7b63d6d97a70530deaf` (2026-10-22 as printed by git) |
| strapi | strapi/strapi | `487dc3ff16d642a759ebfcfe6cf475e16a72767f` (2026-10-21) |
| grafana | grafana/grafana | `0be7d5b210a48ee7cdbdee69bec7bc2935a8c0b5` (2026-10-21) |
| svelte | sveltejs/svelte | `2334f5ed0bc9628fddd9767a92f7f12c09e50cd5` (2026-10-22 as printed by git) |
| apollo-client | apollographql/apollo-client | `c4aeadcd44688b39aa5f60d8bee178531c546028` (2026-10-19) |

Chosen by fit, not fame: monorepos with several packages (backstage, angular, strapi, gsd-pi, n8n, nest, material-ui), class and DI heavy code for implementer questions (angular, nest, vscode, n8n), barrel and re-export heavy code (backstage, angular), generated code (vscode, backstage), plus two smaller libraries as contrast (vue-core, excalidraw). Left out: calcom/cal.com (AGPL, not measured), so the licence screen is shown by grafana (AGPL) and n8n.

## 3. Measurements (TS/JS candidates)

### 3.1 Size, licence, hygiene

| corpus | tracked files | MB | TS/JS files | TS/JS lines | test share of TS/JS files | files with generated marker (first 1 KB) | root licence (SPDX, by text match) | agent-config files to strip |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| **gsd-core (baseline)** | 3,976 | 65 | 1,690 | 1,019,377 | 69% | 18 | MIT | 5 (`GEMINI.md`, `docs/**/AGENTS.md`) |
| gsd-pi | 5,787 | 68 | 4,180 | 1,238,330 | 52% | 6 | MIT | 0 |
| vscode | 20,991 | 316 | 15,426 | 5,032,587 | 31% | 975 | MIT | 95 (`.agents/skills/**`, more) |
| TypeScript | 67,927 | 217 | 26,810 | 1,734,745 | 99% | 91 | Apache-2.0 | 5 (`.github/skills`, copilot) |
| angular | 11,699 | 118 | 7,340 | 1,263,704 | 48% | 12 | MIT | 4 (`AGENTS.md`, `GEMINI.md`) |
| excalidraw | 1,320 | 57 | 716 | 225,620 | 22% | 4 | MIT | 3 (`AGENTS.md`, `CLAUDE.md`, copilot) |
| backstage | 12,313 | 288 | 7,944 | 1,033,426 | 24% | 273 | Apache-2.0 | 9 (`.claude/`, `.cursor/`) |
| n8n | 32,234 | 225 | 23,650 | 4,663,995 | 43% | 53 | **Sustainable Use License (fair-code, not OSI)** | 187 (`.agents/**`) |
| nest | 2,590 | 8 | 2,155 | 190,677 | 28% | 1 | MIT | 0 |
| vue-core | 703 | 7 | 528 | 164,069 | 39% | 4 | MIT | 0 |
| material-ui | 41,537 | 276 | 28,481 | 774,097 | 3% (see note) | 2 | MIT | 15 (`.agents/skills/**`) |
| strapi | 7,147 | 79 | 5,570 | 812,462 | 34% | 1 | MIT (2 other licence files unclassified: check the EE folder) | 5 |
| grafana | 23,923 | 225 | 9,767 | 1,597,745 | 32% | 189 | **AGPL-3.0 (copyleft)** | 17 |
| svelte | 9,270 | 7 | 3,580 | 163,006 | 87% (fixtures) | 14 | MIT | 2 |
| apollo-client | 1,163 | 18 | 792 | 409,134 | 33% | 2 | MIT | 7 (`.claude/`, `.agents/`) |

Notes. The licence column is a text match on the root LICENSE file, not legal advice; "UNCLEAR" files in angular, backstage and strapi sub-folders were not read by hand. Test share uses a path rule (`test(s)`, `spec`, `fixtures`, `e2e`, `*.test.*`); in material-ui most TS/JS files are documentation demos, so its test share reads low. **microsoft/TypeScript on its default branch is no longer the compiler written in TypeScript**: it holds `go.work`, 5,198 `.go` files and tests (26,475 of its 26,810 TS/JS files are test cases); only 157 non-test TS/JS files exist, so it is disqualified as a TypeScript corpus. Agent configuration: every candidate except gsd-pi, nest, vue-core has some; a clean eval checkout must delete them. (The baseline export of gsd-core also contains 5 such paths by this rule, `GEMINI.md` and `docs/**/AGENTS.md`; `probe-notes-2026-10.md` says its exported tree has no `CLAUDE.md`, `AGENTS.md`, `.claude` or `.mcp.json`, which my path rule widens to nested and `GEMINI.md` files. I did not check how the registered preparation treated them.)

### 3.2 Name ambiguity and the grep cost proxy

Random exported-name sample (200 names), then the multiply-declared subset. "files" = files containing the whole word anywhere in the tree.

| corpus | sampled files / eligible | exported decls | distinct names | names in > 1 file | barrel files in sample | **random names: lines med / p90** | **files med / p90** | **> 20 files** | **multiply-declared names: n** | **files med / p90** | **> 20 files** |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | --- | ---: |
| **gsd-core** | 524 / 524 | 2,502 | 2,196 | 172 (7.8%) | 0 | 12 / 49 | 3 / 11 | 4.5% | 172 | 6 / 36 | 14.0% |
| gsd-pi | 2,006 / 2,006 | 7,609 | 7,233 | 194 (2.7%) | 47 | 9 / 38 | 3 / 10 | 4.0% | 194 | 7 / 33 | 19.1% |
| vscode | 3,000 / 10,371 | 7,200 | 6,958 | 135 (1.9%) | 19 | 9 / 61 | 3 / 17 | 10.0% | 135 | 16 / 749 | 45.2% |
| TypeScript | 157 / 157 | 1,332 | 1,244 | 48 (3.9%) | 2 | 9 / 76 | 5 / 15 | 6.0% | not run | | |
| angular | 3,000 / 3,805 | 5,819 | 5,096 | 201 (3.9%) | 186 | 8 / 75 | 3 / 16 | 9.0% | 200 | 10 / 164 | 34.0% |
| excalidraw | 544 / 544 | 1,916 | 1,880 | 12 (0.6%) | 13 | 5 / 28 | 3 / 10 | 7.0% | 12 | 8 / 17 | 8.3% |
| backstage | 3,000 / 5,915 | 3,397 | 2,895 | 166 (5.7%) | 609 | 9 / 58 | 4 / 21 | 10.5% | 165 | 14 / 340 | 39.4% |
| n8n | 3,000 / 13,418 | 5,762 | 5,170 | 132 (2.6%) | 109 | 7 / 40 | 3 / 12 | 5.0% | not run | | |
| nest | 1,546 / 1,546 | 1,511 | 1,094 | 111 (10.1%) | 99 | 8 / 52 | 3 / 15 | 7.0% | 111 | 9 / 32 | 21.6% |
| vue-core | 309 / 309 | 933 | 834 | 26 (3.1%) | 14 | 9 / 64 | 4 / 16 | 7.5% | 26 | 21 / 89 | 53.8% |
| material-ui | 3,000 / 27,275 | 1,529 | 290 | 18 (6.2%) | 54 | 5 / 60 | 3 / 28 | 11.5% | 18 | 23 / 542 | 55.6% |
| strapi | 3,000 / 3,672 | 2,553 | 2,240 | 133 (5.9%) | 156 | 7 / 56 | 3 / 22 | 10.5% | 133 | 9 / 522 | 39.1% |
| grafana | 3,000 / 6,638 | 5,739 | 5,390 | 134 (2.5%) | 21 | 9 / 42 | 3 / 11 | 6.5% | not run | | |
| svelte | 412 / 412 | 1,469 | 1,301 | 124 (9.5%) | 4 | 7 / 73 | 5 / 26 | 12.5% | 124 | 20 / 240 | 49.2% |
| apollo-client | 525 / 525 | 576 | 501 | 44 (8.8%) | 29 | 16 / 384 | 9 / 53 | 20.0% | 43 | 24 / 76 | 55.8% |

(n8n, grafana and TypeScript were not re-run for the multiply-declared subset; their first-run values above are the random-name proxy only. material-ui has only 290 distinct names in 1,529 declarations because its documentation demos repeat names.)

Reading, descriptive. (1) **For random exported names, gsd-core is not an outlier**: median 3 files and 12 lines, 4.5% of names in more than 20 files. Every candidate except apollo-client has a median of 3 to 5 files; the `> 20 files` share is 4% to 12.5% (apollo-client 20%). A corpus swap alone does not change what a grep for a typical name returns. (2) **The separation is in the multiply-declared tail**: the 90th percentile files for such names is 36 in gsd-core and 33 in gsd-pi, against 164 in angular, 240 in svelte, 340 in backstage, 522 in strapi, 542 in material-ui (n = 18) and 749 in vscode. The share of such names in more than 20 files is 14% in gsd-core and 34% to 56% in angular, backstage, strapi, svelte, vscode, material-ui and apollo-client. (3) The proxy counts every textual match across the whole tree, including tests and docs; it is a measure of what a grep must wade through, not of tokens.

### 3.3 Oracle feasibility (compiler-grade keys without installing dependencies)

What was done for gsd-core (`scripts/key-oracle/derive-v2.ts` header, read 2026-10-21): a **syntax-only** oracle. It parses every tracked code file with the repo's `typescript`, no type checker, no program and no tsconfig resolution; it resolves module references by static string evaluation, tracks bindings by name inside a file (rules B, C, R1 to R7), and lists its limits (no re-exports, `module.exports = require(...)`, aliasing through parameters or properties, `bind`). The registered oracle (`scripts/eval/oracle.ts`, version 03-14.1) used TypeScript 6.0.3 on a prepared checkout (`npm ci --ignore-scripts`; preregistration, Corpus section). So the registered precedent already allows an install with scripts disabled; "no install" below is the stricter reading asked for.

Measured: share of sampled static imports that resolve with the tracked tsconfig and no `node_modules` (first 1,500 sampled files).

| corpus | relative imports resolved | workspace-package imports resolved | external imports resolved (expected 0) | tsconfig files | with `references` | with `paths` | `extends` that cannot resolve | package manager | outDir configs | what breaks without install |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| gsd-core | 1,413 / 1,659 (85%) | 0 / 0 | 0 / 767 | 2 | 0 | 0 | 0 | npm | 1 | 14% of relative imports (non-code assets, `.cts` forms) |
| gsd-pi | 5,185 / 5,197 (99.8%) | **2 / 729 (0.3%)** | 193 / 2,068 | 24 | 0 | 3 | 0 | pnpm | 19 | cross-package imports (pnpm links packages in `node_modules`) |
| vscode | 14,181 / 14,259 (99.5%) | 0 / 45 | 95 / 635 | 135 | 0 | 16 | 0 | npm | 58 | few cross-package imports; `vscode` API typings and node typings external |
| angular | 4,207 / 4,208 (99.98%) | **870 / 999 (87%)** | 0 / 748 | 145 | 1 | 56 | 0 | pnpm | 79 | `rxjs`, `zone.js` types become `any`; Bazel-generated sources not in the tree |
| excalidraw | 2,104 / 2,423 (87%) | 1,158 / 1,176 (98%) | 0 / 483 | 12 | 0 | 10 | 1 | yarn | 7 | asset imports (css, svg, json) |
| backstage | 2,433 / 2,472 (98%) | **10 / 1,699 (0.6%)** | 43 / 1,774 | 8 | 0 | 1 | 6 | yarn | 4 | 270 packages link through yarn workspaces only; `@backstage/*` imports unresolved |
| n8n | 2,808 / 2,855 (98%) | 126 / 1,991 (6%) | 639 / 1,484 | 191 | 18 | 45 | **145** | pnpm | 92 | shared tsconfig package not found; workspace links |
| nest | 2,616 / 2,618 (99.9%) | 413 / 1,161 (36%) | 0 / 758 | 151 | 18 | 43 | 0 | npm | 88 | `@nestjs/*` samples import the packages by name |
| vue-core | 1,022 / 1,056 (97%) | 311 / 316 (98%) | 0 / 171 | 6 | 0 | 3 | 0 | pnpm | 2 | almost nothing |
| material-ui | 12,214 / 12,239 (99.8%) | 641 / 669 (96%) | 0 / 1,941 | 69 | 16 | 43 | 0 | pnpm | 18 | React types become `any` (JSX typed loosely) |
| strapi | 3,148 / 3,170 (99.3%) | **0 / 672 (0%)** | 0 / 1,970 | 176 | 0 | 13 | **146** | yarn | 57 | shared tsconfig package not found; workspace links |
| grafana | 4,189 / 4,286 (97.7%) | 8 / 2,310 (0.3%) | 1,182 / 3,038 | 43 | 0 | 4 | 8 | yarn | 2 | workspace links, large external surface |
| svelte | 1,374 / 1,380 (99.6%) | 4 / 10 | 124 / 322 | 6 | 0 | 4 | 0 | pnpm | 0 | JavaScript with JSDoc types |
| apollo-client | 796 / 799 (99.6%) | 508 / 719 (71%) | 3 / 637 | 64 | 43 | 8 | 0 | npm | 8 | `rxjs`, `graphql` types external |

Feasibility reading (judgement). The TypeScript language service (find references, find implementations, call hierarchy) works on a tsconfig without install **inside a package**. Cross-package questions need workspace names mapped to sources. Where the measured workspace resolution is high (angular, excalidraw, vue-core, material-ui, apollo-client) the tsconfig `paths` already do this. Where it is near zero (backstage, strapi, gsd-pi, grafana, n8n) the oracle needs one of: a synthesized `paths` map built from the tracked `package.json` names and `main`/`types`/`exports` fields (script work, my estimate 1 to 3 days per corpus with checks), or a registered `install --ignore-scripts` step as for gsd-core (large `node_modules`: backstage and n8n are big monorepos; sizes not measured, no install was run). Unresolved external packages make their types `any`; references through such values are not found by the compiler, so keys are "the set the compiler can prove", and a correct agent answer found by reading code can be scored wrong. The same limit already holds for the v2 oracle (name-based, documented). **The v2 key oracle itself does not transfer**: it encodes gsd-core's `.cts` to `.cjs` and `require` patterns (rules F1 to F6, R3, R4), so a new corpus needs a new compiler-based oracle (language service references/implementations, then the same exact-set rule and `verifyCitation`). That is the largest piece of work and it is not shared across corpora except for the harness.

## 4. Fit with the registered design

- **>= 50 questions per corpus incl. abstain (EVL-02).** All TS/JS candidates have enough exported names (gsd-core's 75 came from 2,196 names). The scarcer input is *ambiguous* names: 135 or more in vscode, angular, backstage, strapi, svelte, gsd-pi, nest; only 12 in excalidraw, 18 in material-ui (sample), 26 in vue-core, 43 in apollo-client, so those four can supply a hard 50 only by widening to methods or all names (not measured). Abstain cases (a plausible name that does not exist) are available anywhere.
- **Categories.** Registered mix: callers 17, references 8, heritage 8, emit 10, adr 10, impact 6, definition 7, abstain 9. `callers`, `references`, `impact`, `definition`, `abstain` apply everywhere. `heritage` needs classes: line-start class-heritage declarations counted in `.ts/.tsx`: vscode 12,612, n8n 4,160, angular 1,984, nest 529, backstage 504, gsd-pi 289, grafana 406, strapi 89, apollo 38, excalidraw 24, vue 22, material-ui 13, svelte 6, gsd-core 0 by this regex. `adr` (comments citing ADR numbers) is gsd-core specific and has no counterpart elsewhere; a replacement category (for example `@deprecated` or tagged TODO citations) would be a design change and a new registration. `emit` (compiled output path, consumers of the emitted file): the `.cts` to `.cjs` mapping is gsd-core specific. Generic `outDir`/`rootDir` mapping exists where tsconfigs set `outDir` (nest, angular, n8n, strapi, gsd-pi, vscode have many), but whether consumers `require` the emitted path is rarely true (ESM); I expect `emit-consumers` to be inapplicable on most candidates (judgement, not measured).
- **Pinning (FND-08).** Add an entry to `corpora/corpora.json` with `repo`, `ref`, full `sha`, `pinnedAt`; the manifest validator already exists. Preparation needs the same record as OQ8 (`npmCiRan`, lockfile sha256) if an install is used.
- **Prepared checkout size.** From section 3.1 (tracked bytes, before any install): gsd-core 65 MB, angular 118 MB, nest 8 MB, vue-core 7 MB, gsd-pi 68 MB, backstage 288 MB, strapi 79 MB, vscode 316 MB. Each atlas session starts from a copy-on-write clone plus an index build (about 5.9 s for 3,977 files at gsd-core, `pilot.md`); index time and memory for 15,000 to 28,000 TS/JS files (vscode, material-ui, n8n) were **not measured**.
- **Session cost (estimate).** gsd-core: grep sessions average 29,393 billable tokens in the registered run (`reevaluation-options.md` 2.5) and 45,242 mean / 38,259 median in probe P3 (`probe-notes-2026-10.md`), 3.2 to 3.5 tool calls; registered full run about 16 USD notional and about 6.5 h for 450 sessions. On a corpus whose targets have p90 100 to 700 matching files, a grep session will read more output per call and make more calls; my estimate is 1.5x to 3x tokens per grep session (60k to 130k), so 450 sessions would be about 25 to 50 USD notional and 10 to 20 h (estimate; unmeasured). The atlas arm's fixed context (+4,780 tokens per request in the registered arm; +1,070 at best with tool search and no skill, `probe-notes`) is the same on any corpus, so the arm can only win where a grep session costs well over that per request.
- **Max allowance for 450 sessions.** The probes recorded a Max seven-day reading of 0.11 at the first session and 0.12 at the last, over 10.848 USD notional and 96+ sessions (`probe-notes`, Costs and rate limits). That is too coarse to extrapolate with confidence: a linear reading says a 16 USD run is a few percent of the weekly window and a 50 USD run under ten percent, but the readings were rounded and the usage is not linear in notional USD. A real estimate needs a pilot of 20 to 30 sessions on the chosen corpus reading the same rate-limit events; I did not run one.

## 5. Ranking (agent's judgement)

Criteria and weights (sum 100). Scores 0 to 5, points = score / 5 x weight.

| criterion | weight | basis |
| --- | ---: | --- |
| H. grep is expensive for question targets | 35 | multiply-declared-name p90 files and share > 20 files (3.2), supply of such names |
| O. compiler oracle feasible without install | 20 | relative and workspace resolution, `extends`/`paths` health (3.3) |
| L. licence and checkout hygiene | 10 | SPDX, copyleft, agent configs to strip (3.1) |
| S. size and run cost | 10 | tracked MB, lines (3.1); smaller or equal to gsd-core scores higher |
| Q. question supply | 10 | files, names, heritage, categories (4) |
| C. low contamination | 10 | judgement: less famous, less likely in training data |
| F. fit with the plan | 5 | EVL-04 names gsd-pi; others none |

| rank | corpus | H | O | L | S | Q | C | F | total |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | vscode | 5 (35) | 4 (16) | 4 (8) | 1 (2) | 5 (10) | 1 (2) | 2 (2) | **75** |
| 2 | angular | 4 (28) | 4 (16) | 4 (8) | 3 (6) | 5 (10) | 1 (2) | 3 (3) | **73** |
| 2 | backstage | 5 (35) | 2 (8) | 4 (8) | 2 (4) | 5 (10) | 3 (6) | 2 (2) | **73** |
| 4 | strapi | 4 (28) | 2 (8) | 3 (6) | 4 (8) | 4 (8) | 3 (6) | 1 (1) | **65** |
| 4 | svelte | 4 (28) | 3 (12) | 4 (8) | 5 (10) | 2 (4) | 1 (2) | 1 (1) | **65** |
| 6 | vue-core | 2 (14) | 5 (20) | 5 (10) | 5 (10) | 3 (6) | 1 (2) | 2 (2) | **64** |
| 7 | gsd-pi | 1 (7) | 4 (16) | 5 (10) | 3 (6) | 4 (8) | 5 (10) | 5 (5) | **62** |
| 7 | apollo-client | 3 (21) | 4 (16) | 3 (6) | 4 (8) | 3 (6) | 2 (4) | 1 (1) | **62** |
| 9 | material-ui | 3 (21) | 4 (16) | 4 (8) | 2 (4) | 4 (8) | 1 (2) | 2 (2) | **61** |
| 10 | nest | 1 (7) | 4 (16) | 5 (10) | 5 (10) | 4 (8) | 2 (4) | 2 (2) | **57** |
| 11 | excalidraw | 1 (7) | 4 (16) | 4 (8) | 4 (8) | 3 (6) | 2 (4) | 2 (2) | **51** |
| 12 | n8n | 2 (14) | 2 (8) | 1 (2) | 1 (2) | 5 (10) | 3 (6) | 1 (1) | **43** |
| 13 | grafana | 2 (14) | 2 (8) | 1 (2) | 2 (4) | 4 (8) | 2 (4) | 0 (0) | **40** |
| 14 | TypeScript | 1 (7) | 1 (4) | 4 (8) | 1 (2) | 1 (2) | 1 (2) | 0 (0) | **25** |
| ref | gsd-core | 1 | 3 | 4 | 3 | 4 | 2 | 5 | not ranked (baseline) |

Hardness scores: 5 = p90 files of multiply-declared names above 300 with at least 100 such names; 4 = 150 to 300 (or 49% > 20 files); 3 = high share but thin supply (n < 50); 2 = unmeasured tail with middling random-name proxy; 1 = tail p90 near gsd-core's 36. Scores are judgement calls on these thresholds; the totals are within a few points of each other (vscode 75, angular 73, backstage 73), which is inside the noise of my weights: a different weighting (for example oracle 30, contamination 15) moves backstage and angular above vscode and gsd-pi up by about ten points. Do not read the order of the top three as a measurement.

### Recommendation (agent's judgement, not a decision)

- **(a) Next single corpus: angular.** MIT, 118 MB and 1.26M TS/JS lines (the same size class as gsd-core, so cost per session should not be far above the registered run), the multiply-declared tail is expensive for grep (p90 164 files, 34% of such names in more than 20 files, 200 such names available), 1,984 class heritage declarations for implementer questions, barrel files in 186 of 3,000 sampled files, 87% of workspace imports resolve from the tracked `paths` without install, `outDir` configs exist for an emit-style category. Costs: very well known (contamination), 4 agent-config files to strip, rxjs and zone.js types unresolved without install.
- **Alternative if contamination matters more: backstage** (Apache-2.0, less likely memorised, 609 barrels per 3,000 sampled files, tail p90 340 files, 270 packages) but its workspace links resolve only 0.6% without an install, so the oracle needs a synthesized package map or a registered install.
- **(b) Two-corpus plan: angular (hard) plus gsd-pi (the planned EVL-04 sibling and the unlikeliest to be in training data).** gsd-pi's own proxy is gsd-core-like (tail p90 33), so it serves as the control for "does the corpus matter", and EVL-04 needs it anyway. A paired pooled analysis across a low-ambiguity and a high-ambiguity corpus would tell whether the ratio moves with ambiguity. If a second hard corpus is wanted instead, backstage after the oracle work above.
- **Not recommended:** microsoft/TypeScript (no longer TS source), n8n (licence, 187 agent files, `extends` unresolved), grafana (AGPL), vscode as the first corpus (316 MB, 5.0M lines, 95 agent-config files, most famous repository; its high H score is real but cost and index load are unmeasured).

## 6. Risks

1. **The result may again be "grep is cheap".** Predictive property, measured here: the grep cost of the *question targets*. For random exported names every candidate resembles gsd-core (median 3 to 5 files). The advantage appears only if questions are drawn from the multiply-declared tail (tail p90 164 to 749 files vs 36 in gsd-core). A question set drawn by the registered method (a seeded shuffle of a compiler census) would mostly pick distinctive names, and the corpus would add little. The question selection rule is therefore as decisive as the corpus and must be registered in advance. A second predictor, from the probes: the fixed context (+1,070 to +4,780 tokens per request) and the 22% unforced adoption (P3); even a perfect corpus does not fix an arm that rarely calls its tools.
2. **Contamination.** Angular, vscode, vue, svelte, material-ui and nest are heavily represented in public text and training data (judgement); a model may answer from memory. gsd-pi (and gsd-core) are the least likely. Mitigation: pin a recent SHA and prefer questions on symbols added recently (not measured).
3. **Licence.** n8n (Sustainable Use License) and grafana (AGPL-3.0) are screened out. The eval does not redistribute the code, but the screen was asked for. Strapi's two unclassified licence files and angular's unclassified sub-folder files need a human read.
4. **Oracle work.** A new compiler-based oracle is the main cost and the main correctness risk: unresolved packages make `any`, the v2 oracle's name-based rules do not transfer, and keys must be audited (the gsd-core key audit found problems after the run; `key-audit.md`).
5. **Scale.** Index time and memory of the atlas TypeScript module on 10,000 or more files are unmeasured; the 450-session run could cost several times the registered one.
6. **Category changes** (no `adr`, probably no `emit-consumers`) mean the question mix is no longer the registered one: a new registration, not a re-run.

## 7. Later-phase candidates (non-TS, lightly measured; not part of the ranking)

Clones on 2026-10-21 (shallow), counts from `git ls-files`.

- **Swift app for SWF-04/SWF-05: NetNewsWire** (`Ranchero-Software/NetNewsWire`, `b808eaad89fa535063db3465183a46e754af66f9`). MIT, 724 `.swift` files and 10 `.m`, 103,526 Swift lines, modular Swift packages; a `CLAUDE.md` exists (1 agent file to strip). Small enough to hand-verify an 85% precision sample. Alternative: **wikipedia-ios** (`wikimedia/wikipedia-ios`, `2407d77c3be3ae5ac0721d00c2ac665847b09d19`), MIT, 1,461 `.swift` plus 208 `.m`, 229,546 Swift lines, Swift/Objective-C mix (a useful stress for cross-language references), 7 agent-config files (`AGENTS.md`, `CLAUDE.md`, others). Neither was parsed with the Swift grammar here.
- **C++: abseil-cpp** (`abseil/abseil-cpp`, `e92c357f19dfd9c2390d388aaa98e72adb2abac0`). Apache-2.0, 490 `.cc` (185,737 lines) and 385 `.h` (103,650 lines), no agent configs; heavy templates, macros and overloading make grep and any tree-sitter tier both hard; a compiler-grade oracle (clang index/clangd) would need a `compile_commands.json` and a build setup, which this note did not test. Larger alternatives (LLVM, Godot, Chromium) were not cloned.
- **Python: django** (`django/django`, `3c85ea391e27bdcf25ea5b7592486ad55f4f8350`). 2,937 `.py` files, 529,462 lines; licence header present (BSD-style, not machine-classified here); no agent configs. Useful as a second Python corpus beside the planned gsd-path (INT-03, 553 files stored as 230 distinct contents), whose oracle could be pyright or scip-python; neither was tested.

## 8. Limits

- **Single machine, single day** (macOS arm64, 2026-10-21). Shallow clones at moving HEADs; the pin for a real run must be re-resolved and the measurements repeated at that SHA.
- **Proxy, not tokens.** The grep numbers count textual matches over the whole tree for sampled names; no model session was run, so no claim is made about tokens, accuracy or cost beyond the labelled estimates.
- **Not measured:** an actual language-service run (find references, implementations) on any candidate; index time and memory of atlas on any candidate; `node_modules` size after install; the sizes of generated files outside the marker heuristic; the multiply-declared-subset grep for n8n, grafana and TypeScript; the name sample for TypeScript (157 files only); hand-reading of unclassified licence files; legal review; whether upstream repositories change their licences or agent files later; contamination (judgement only, no probe).
- **Heuristics.** Generated-file count is a first-1-KB marker regex; test paths are a name rule; class heritage is a line-start regex; exported names exclude re-exports, methods and types, so ambiguity of methods (the commonest source of same-name confusion in class-heavy code) is understated; names under 3 characters are excluded from the grep sample; the resolution check uses the nearest `tsconfig.json` and ignores `include`, so a file outside any project's `include` still counts as resolvable. Resolution with `moduleResolution` fallback `Bundler` is used where no tsconfig is found.
- **gsd-core baseline row** is measured the same way on the `git archive` export; its 14% relative-import non-resolution is mostly non-code assets and `.cts` forms and was not inspected file by file.
- **Web research.** No web page was fetched. All facts are from the clones and from files in this repository (`.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `docs/eval/preregistration.md`, `probe-notes-2026-10.md`, `reevaluation-options.md`, `corpora/corpora.json`, `scripts/key-oracle/derive-v2.ts`), read 2026-10-21. Statements about public repositories (for example the microsoft/TypeScript default branch now holding the Go port) are what the clone contained that day.
- **Max allowance.** Not estimated beyond the coarse remark in section 4; a pilot on the chosen corpus is the way to get it.
