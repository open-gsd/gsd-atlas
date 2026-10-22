# Plan for an unscored angular pilot (2026-10-21)

**Status: a plan and a feasibility report. Nothing here is registered, scored or approved.** The registered verdict `OVERALL: MVP not met` stands; no registered file, key, result or skill was touched. No decision record is described as ratified. All design choices below are the author's proposals; those the user must decide are collected in section 9. No model session was run and no money was spent: every number in section 2 comes from reading the pinned checkout, running this repository's own code on it, and parsing with this repository's `typescript` 6.0.3. No code from the checkout was run (no install, build, script, bazel or test).

Data: `docs/eval/angular-pilot/sample-keys.json` (5 prototype keys with their `git grep` cross-check), `docs/eval/angular-pilot/census-window.json` (328 candidate declarations with their measured grep cost, key size and age). Code (tests first, RED then GREEN commits): `scripts/angular-pilot/` (`oracle-lib.ts`, `census.ts`, `sample-keys.ts`).

## 1. Purpose and non-goals

Purpose. `corpus-candidates.md` found that for random exported names every candidate corpus is as cheap to grep as gsd-core, and that the separation is in the multiply-declared tail. `probe-notes-2026-10.md` found that on gsd-core the best fixed-context atlas configuration still costs about 1.14x to 1.32x grep (projection) and that unforced adoption was 22%, 0/4 under tool search. The pilot asks one question: **on a corpus where grep is expensive for the question targets, does atlas cost fewer tokens than grep at comparable correctness?** It also tells us the real cost of a registered angular run, whether a compiler oracle for angular is affordable, and whether the grep premise (grep is expensive on these targets) holds in tokens, not only in file counts.

Non-goals. Not a verdict and not a replacement for the registered run. Its sessions are never pooled with the registered 450 or with the gsd-core probes. No hypothesis test, no significance claim; descriptive numbers and bootstrap intervals over questions only. No change to atlas, to the registered harness, to the skill or to any key. Not a statement about angular maintainers' code.

## 2. Zero-cost feasibility checks (done now)

Pin: `angular/angular` `3cc1edf3210a9debb0be57a4e99e53a54505db32` (commit date 2026-10-21), the clone used by the earlier survey (11,699 tracked files, 7,340 TS/JS). A second, history-only clone (`--filter=blob:none --no-checkout`, 38,998 commits) was made in the scratchpad solely to date files.

### 2a. Can atlas index the tree without installing dependencies? Yes.

`gsd-atlas build` and `maintain resolve` (the same two steps the harness runs before an atlas session) on a copy-on-write scratch copy of the clone, fresh store, `nice -n 10`, `/usr/bin/time -l`, macOS arm64, Node 26.11.1, atlas built from this worktree:

| step | wall | max RSS (`time -l`) | peak footprint (`time -l`) | outcome |
| --- | --- | --- | --- | --- |
| `build` | 42.3 s | 4.48 GB | 0.62 GB | 6,924 files seen, 6,367 parsed, 557 linked, 1 failed (`source_too_large`), diagnostic `resolver_timeout` (the compiler pass did not finish in its bound) |
| `maintain resolve` | 42.5 s | 4.77 GB | 0.48 GB | complete; 315,497 reference sites asked of the compiler, 223,215 answered (71%); diagnostic: no project TypeScript, the bundled 6.0.3 was used |

Store on disk: 192 MB. The two RSS columns disagree by 8x; I do not know which one is the right "memory" figure (the first is what the OS kept resident including freed-but-resident pages, the second is the footprint the kernel charges). Treat 5 GB as the safe planning number for one index build and do not build two at once. For comparison `pilot.md` records about 5.9 s for gsd-core's 3,977 files. Per atlas session the index costs about 85 s of wall time that is outside the token count (the registered harness builds in each session's clone). Whether a store built once can be copied with the checkout (the store directory name looks derived from the path) is **unverified**; if not, 64 atlas sessions cost about 1.5 h of index time.

### 2b. Compiler oracle prototype without `node_modules`

`scripts/angular-pilot/oracle-lib.ts` creates a TypeScript language service over the tracked sources of `packages/` (the checkout's `packages/tsconfig.json` `compilerOptions` only; `baseUrl` `..`, `paths` `@angular/*` to `./packages/*`; `types: []`, `moduleResolution` forced to Bundler, `ignoreDeprecations` 6.0). It offers `references`, `callSites` (references that are the callee of a call, `new`, tagged template or decorator call), `directSubtypes` (heritage clauses resolved by the checker, direct only) and `unresolvedSpecifiers`. Six unit tests on a synthetic workspace pass (paths, re-exports, a same-name function in another package, a spec file left out, an unresolved external).

Result on the real tree (1,910 non-test files, or 3,589 with specs): program setup plus import scan 1.6 s and 0.64 GB RSS; each query is a lazy type-check (the 699-declaration census, with call sites or subtypes per declaration, took 58 s without tests and 90 s with).

What resolves to `any`. Every unresolved import specifier in the 1,910 files: 39 distinct. `@angular/*` workspace imports resolve except `@angular/ssr` and `@angular/ssr/node` (1 file each); relative imports 0 failures. External: `typescript` 263 files (14%; compiler-cli, language-service, migrations), `rxjs` 85 plus `rxjs/operators` 29, Node built-ins 81 file-imports, `@babel/core` 13, `vscode-languageserver` 10, `magic-string` 5, `semver` 5, `tinyglobby` 5. Consequence: references and calls that flow through values typed by these packages are invisible to the compiler (for example `ts.factory.create...` results in compiler-cli, observable chains). Our targets are angular's own symbols, so only a use that reaches angular code through an `any`-typed value is lost; that is the main false-negative risk and it concentrates in compiler-cli and language-service.

Five sample questions, keys from the oracle (file sets; definition file excluded), each cross-checked by whole-word `git grep -w` over `packages/` in the same scope and by reading every disputed file:

| sample | oracle key (files) | grep files | grep-only files | what the grep-only files are (checked by reading imports) |
| --- | --- | --- | --- | --- |
| callers of `isInSkipHydrationBlock` declared in `core/src/render3/state.ts` | 4 | 8 | 4 | the other function of that name in `core/src/hydration/skip_hydration.ts`, its 3 importers, and the definition file |
| callers of `findTightestNode` in `language-service/src/utils/ts_utils.ts` | 12 | 15 | 3 | a second function of that name in `compiler-cli/preprocessor/language-service/src/references_and_rename_utils.ts` and its importers |
| callers of `splitNsName` in `compiler/src/ml_parser/tags.ts` | 9 | 12 | 3 | a second function in `core/src/render3/util/tags.ts` and its 2 importers |
| references to the interface `DirectiveMeta` in `compiler/src/render3/view/t2_api.ts` | 6 | 28 | 22 | all import the unrelated `DirectiveMeta` from `compiler-cli/.../metadata` (20 files by import path read with a script; 2 files only re-export or mention it) |
| direct subtypes of `AstVisitor` in `compiler/src/expression_parser/ast.ts` | 3 | 7 | 4 | `animations/browser` has its own `AstVisitor`; `compiler-cli/preprocessor/src/selectorless.ts` imports `RecursiveAstVisitor as AstVisitor` |

In all five the oracle's key is a subset of the grep hits and every grep-only file was a different symbol of the same name (key-only files: 0). So on these samples the oracle was right where the gsd-core sessions-versus-key experience would predict trouble, and a name-based grep arm is led into 2x to 5x more files than the key. Limits of this evidence: n = 5, one reader, the samples were chosen for ambiguity, and the same compiler and `paths` setup produced the key and (for atlas) the answer. The gsd-core lesson (sessions found genuine hits the key missed) means the audit step in section 7 must repeat this cross-check for every pilot question and again against the calibration sessions' answers.

Atlas against the same keys (read-only CLI calls on the index above, no model): `refs` returned exactly the oracle's files for `isInSkipHydrationBlock` (4/4) and `splitNsName` (9/9) and the oracle's 12 plus one spec file for `findTightestNode` (spec files were outside the prototype scope; this is a scope mismatch, not an error). For the type references to `DirectiveMeta` atlas found 2 of the oracle's 6 files, missed 4 (the ones that import it under an alias, `DirectiveMeta as T2DirectiveMeta`, and use it in heritage clauses) and returned 1 spec file. The pilot would therefore measure a real atlas recall gap on aliased type references, which is useful, not a defect of the pilot. The CLI has no implementers command, so `heritage` questions need a check of which tool an atlas session would use (`code_refs` on the interface, `code_context`); **unverified**.

### 2c. Question supply in the ambiguous tail (measured, spec files in scope for references)

Method. Targets are exported top-level declarations in tracked non-test `packages/**/*.ts` (1,910 files, 7,404 declarations). A name declared in two or more files is ambiguous: 302 names, 699 candidate declarations (every declaration of such a name is its own candidate). Each candidate got: the number of tracked files in the whole tree containing the name as a whole word (`git grep -l -w -F`), the oracle's number of files with call sites (functions and consts) or its number of direct subtypes (classes and interfaces), spec files included in the program. Window: 10 to 150 grep files (below 10 the grep is not expensive; above 150 the key is not answerable by reading).

| quantity | value |
| --- | --- |
| ambiguous names / candidate declarations | 302 / 699 |
| grep files over all 699: median / p90 / max | 14 / 257 / 2,989 |
| candidates with more than 20 grep files | 42% |
| in the window 10..150 | 328 declarations, 147 distinct names |
| window, `callers` (function/const, 2..40 files with calls) | **42** declarations, 30 names; key median 3 files; grep median 18 |
| window, `heritage` (class/interface with 1..40 direct subtypes) | **41** (21 with 2 or more), key median 1 |
| window, `references` and `definition` (any declaration kind) | **328** (147 names) |
| window, grep files / key files, median (callers) | 6 (10th percentile 1.7) |
| `impact` depth two | not measured (needs the enclosing function of each call site; a subset of the callers supply) |
| `abstain` | unlimited (a plausible name with zero whole-word hits in the tree) |
| without spec files in the program | callers 23 (17 names), heritage 40 (17 with 2 or more) |

Reading. The tail is expensive for grep as `corpus-candidates.md` said (p90 257 files against 36 for gsd-core), but **inside the answerable window the advantage over gsd-core is smaller than the headline**: the callers' grep median is 18 files and the window's median 28, against gsd-core's tail median 6 and p90 36. The lever is the ratio of grep files to key files (median 6), that is, how many wrong-symbol files a name search drags in, more than the absolute count. `callers` supply (42, 30 names) covers a 16-question pilot and a 15-question registered category but not more; a 50-plus registration of the registered shape needs the callers category to widen (methods and class members are not in this census and are the commonest source of same-name confusion in class-heavy code; not measured) or a second package set (`adev`, `devtools`, `modules`).

## 3. Question design (proposal)

Selection rule, stated before any question is drawn, seeded `20261021` (new; the registered seed 20261017 stays untouched):

1. Candidate = a row of `census-window.json`: grep files 10..150, another declaration of the same name in a different non-test file, key size (files) 2..25 (the cap keeps exact-set scoring tractable), declaring file last changed on or after 2026-01-01 (241 of the 328 rows; contamination mitigation, section 8).
2. Order candidates by `sha256("20261021\0<name>@<declaring file>")`, take them in order per category, one question per distinct name, skipping a candidate when the audit (section 7) finds an unresolvable key defect; every skipped candidate is listed with its reason.
3. The question wording names the declaring file ("the function `x` declared in `packages/a/b.ts`; another function of the same name exists elsewhere and is a different symbol"), so the target is unambiguous to a human and to an agent.

Categories (pilot of 16; later registration 50 or more per EVL-02):

| category | pilot | a later 50+ | notes |
| --- | ---: | ---: | --- |
| callers | 5 | 15 | supply 42; wording below |
| references | 3 | 9 | any kind of declaration; includes type positions |
| heritage (direct subclasses/implementers) | 3 | 9 | file plus class name, as the registered `file+symbol` granularity; supply 41 |
| impact (depth two) | 2 | 6 | callers of the callers; a subset of callers' supply; counting rule must say whether tests count |
| definition | 2 | 7 | for an ambiguous name, "which file declares the one that ...", granularity `file+line` |
| abstain | 1 | 4 | name absent from the tree |
| dropped | `adr` (angular has no ADR citations), `emit` (angular builds with Bazel; a compiled-path question has no meaning here) | | the category change makes any later run a new registration |

Counting rules to put in every question wording (learned from `key-set-v2/changes.md` and `key-audit.md`; decisions are proposals):

- Scope: tracked `.ts` files under `packages/`, excluding `.d.ts`, `schematics/`, `examples/` and `integrationtest/` directories. **Spec and test files are in scope** (the registered gsd-core run counted tests; atlas indexes them; excluding them would need each session to filter by path and would make atlas and grep disagree for a reason that is not about ambiguity).
- A use is a reference in executable or type position. Import specifiers, export specifiers and `export ... from` re-exports (barrel files) are not uses; a file that only re-exports does not count. A use through an alias (`import {X as Y}`, `export {X as Y}`) counts as a use of X (the `DirectiveMeta` sample shows grep misses these by name and the compiler does not).
- Type-only mentions count for `references` (annotations, generic arguments, `extends`/`implements`), and do not count for `callers`, which means call expressions, `new`, tagged templates and decorator calls such as `@Foo()`.
- Mentions in comments, JSDoc `{@link}`, string literals and property keys that merely spell the name are not uses (the `q-012` lesson). Dependency-injection tokens: `inject(TOKEN)` and `@Inject(TOKEN)` are ordinary references to `TOKEN`; a token spelled as a string is not.
- A same-name symbol declared in another file is a different symbol; its uses must not be listed.
- Angular HTML templates and inline `template:` strings **do not count**. In scope there are 2 `@Component` decorators with an inline template and 7 non-test `.html` files in `packages/`; for these targets the choice changes nothing, and the compiler cannot see templates. State it in the wording anyway. `import x = require` does not occur in the scope and is left out of the wording.
- Granularity and equality: `file` for callers, references and impact; `file+symbol` for heritage; `file+line` for definition; `exact-set`. Exact-set on a key of 20 or more files is brittle (one missed barrel kills the answer); the pilot caps keys at 25 and reports, beside exact-set equality, the matched/missing/extra counts so a near miss is visible.
- Impact depth two: files of direct callers plus files of callers of those callers, excluding the target's own file; the wording gives the formula.

## 4. Conditions and run design (proposal)

Conditions, all through `scripts/probes/driver.ts` and `configs.ts` (read-only reuse; the driver may need small new options, see section 7):

| id | arm | note |
| --- | --- | --- |
| G | grep arm as registered (`Bash`, `Read`, the registered read-only shell list) | |
| A-ts | `atlas-noskill-ts`: seven atlas tools deferred through `ToolSearch`, no skill, no skill plugin | best measured fixed context (first request 7,104 vs 6,034 for G); adoption under this configuration was 0/4 in the one test of `atlas-ts`, so adoption itself is part of what is measured |
| A-reg | the registered atlas arm (tools upfront, skill plugin) | continuity anchor with the registered run and the gsd-core probes (22% adoption) |

Not forced routing: it tripled tokens and lowered agreement in P3.

Plan: 16 questions x 2 runs x 3 conditions = 96 sessions, the same size as P3 (so P3 is the cost and noise reference). Order: each (question, run) forms one adjacent group of the three conditions in random order, groups shuffled with seed `20261021` (the registered scheme, extended from two arms to three). Concurrency 1 (atlas builds take about 5 GB each; sessions run under `nice -n 10`), or 2 for grep-only chunks. Model `claude-sonnet-5-5`. Answer schema: `scripts/eval/answer-schema.json` unchanged (`found`/`not_found` plus items with path, optional line and symbol), prompt `buildPrompt` unchanged, so the pilot differs from the registered run in the corpus, the conditions and the question set only. Isolation flags as in the probes: `-p --output-format stream-json --verbose --setting-sources "" --strict-mcp-config --mcp-config <file> --tools ... --allowedTools ... --max-budget-usd N --json-schema <schema> --model claude-sonnet-5-5 --no-session-persistence`; ANTHROPIC* and CLAUDE* variables stripped from the child (`scrubbedEnv`); auth check by the four-field filter before each chunk.

Claude Code version: **use the installed 2.1.305** for all sessions of the pilot and record it in every record (the probes did the same). Reasons: the pilot is unregistered and compares conditions only against each other; the registered gate pins 2.1.302 for a scored run, so a registration would re-pin and re-run, and installing an older build for an exploratory run adds risk (auto-update, a different `ToolSearch` default) for no comparability gain. Absolute numbers must not be compared with the registered run either way.

Checkout preparation. The registered preparation (`prepare-corpus.ts`, `cloneCheckout`) copies a prepared tree and **does not strip agent-config files**: I checked the pinned gsd-core tree (`git ls-tree -r 10ac3a7a...`): it contains `GEMINI.md`, `docs/AGENTS.md` and three translated `docs/*/AGENTS.md`, plus `.claude-plugin/`; `probe-notes-2026-10.md` says the exported tree has no `CLAUDE.md`, `AGENTS.md`, `.claude` or `.mcp.json`, which is true only of the root and of those exact names. For angular the equivalent set is large and aimed at agents: root `AGENTS.md`, nested `AGENTS.md`/`GEMINI.md` (`adev/src/context/`, `packages/compiler-cli/preprocessor/`), `.agent/` (rules, workflows and `skills/reference-core`, `reference-compiler-cli` that describe the packages), `.gemini/`, a root `skills/` directory (46 files, `angular-developer` references), `context7.json` and `adev/src/llms.txt`. Proposal: a new `scripts/angular-pilot/prepare-checkout.ts` exports the pinned tree with `git archive`, deletes exactly that list (any `AGENTS.md`, `GEMINI.md`, `CLAUDE.md` at any depth; `.agent/`, `.gemini/`, `.claude/`, `.cursor/`, `skills/`; `.mcp.json`, `context7.json`, any `llms*.txt`), writes the removed paths and the tree's file count into a preparation record, then `git init` + one commit (atlas needs blob ids; the probes did this). Both arms get the identical stripped tree. No `npm`/`pnpm install` (nothing to install usefully; Bazel/pnpm would also add a huge tree). Whether Claude Code 2.1.305 reads `AGENTS.md` when there is no `CLAUDE.md` is **unverified**; stripping removes the question. The gsd-core registered run kept its few such files, so angular is not like-for-like on this point, which is another reason not to pool.

Also recommended, cheap: a **closed-book control** of the same 16 questions with no tools (one-turn sessions, about 7k tokens each, under 1 USD notional in total) to estimate how much of each answer is available from memory (section 8).

## 5. Cost and safety

Basis: probe P3 (gsd-core, 96 sessions, 7.891 USD notional): grep 45,242 billable tokens mean (38,259 median), 0.053 USD per session, 13.4 s; registered atlas 67,846, 0.062 USD; routed 156,115 (not planned). The 1.5x to 3x multiplier for a grep session on this corpus is an estimate from `corpus-candidates.md` and is the first thing the calibration batch tests.

| stage | sessions | notional USD (estimate) | wall (estimate) |
| --- | ---: | ---: | ---: |
| closed-book control | 16 | 0.3 to 0.6 | 5 min |
| calibration batch: 4 questions x 3 conditions x 1 run | 12 | 1.5 to 3 | 20 to 30 min incl. 8 index builds |
| pilot proper | 96 | 12 to 24 (P3 scale 7.9 x 1.5 to 3) | 2 to 4 h sequential incl. about 64 index builds at 85 s if the store cannot be reused |
| total | 124 | about 14 to 28 | about 3 to 5 h |

Max allowance: probes moved the seven-day reading from 0.11 to 0.12 over 10.8 USD notional, too coarse to extrapolate; the calibration batch re-reads it. Guardrails identical to the probes: `scripts/probes/limits.ts` stops at 0.60 on the five-hour or seven-day window; `isUsingOverage` must be false and `overageStatus` rejected in every reading (stop on any other value); subscription login only, no API key, `apiKeySource` none in every init event; checked after every session; `nice -n 10`; concurrency 1 (2 only for grep-only chunks). Per-session `--max-budget-usd` 1.5 (the probes used 0.8 to 1.0; angular outputs are larger). Hard notional cap: calibration 4 USD, whole pilot 30 USD. Chunks of 16 sessions (8 question-run groups of three, rounded to groups), with a check after each chunk: failures/non-ok statuses, cumulative notional against the cap, rate-limit readings, and the stop lines below.

Stop lines (any one stops the run until the user decides): cumulative notional above 30 USD; five-hour or seven-day reading at or above 0.60; overage not off; more than 10% non-ok sessions in a chunk; the calibration grep mean above 4x the gsd-core P3 mean (about 180k billable tokens), which says the cost model is wrong by more than the plan allows; any session differing from its condition's registered environment in the init event.

## 6. Decision rules (the pilot's own, written before any data; the author's proposal for the user to adopt or change)

Definitions. Billable tokens as in the registered design (input + output + cache creation + cache read). Ratio R = mean over questions of (mean billable of A) divided by mean over questions of (mean billable of G), for A-ts and A-reg separately, with a bootstrap (10,000 draws over questions, seed 20261021) interval. Correctness = share of sessions whose answer set equals the audited key (exact-set), per condition. Adoption = share of A sessions with at least one atlas tool call.

Premise check, before reading R: the grep condition's mean billable tokens must be at least 1.5x the gsd-core P3 grep mean (at least about 68k). If it is below 55k, the premise "grep is expensive on these targets" failed in tokens: report that as the finding, do not register on this corpus, and go back to the question rule (a harder window) before spending more.

Outcomes (n = 16 questions, so these are triage thresholds, not tests):

- **Worth a registered angular run** if A-ts or A-reg has R <= 0.85, correctness(A) >= correctness(G) - 0.10, adoption >= 50%, and the premise check passed. A registration would then take the 50-plus question set, the full oracle audit, and a new preregistration; the pilot is not part of it.
- **Stop and reconsider the token gate** if both A conditions have R >= 1.10 and the premise check passed (atlas costs more than grep even where grep is expensive), or if atlas sessions that made an atlas call cost at least as much as G sessions on the same questions. Then the gate (atlas uses fewer tokens than grep) is probably not attainable by tuning on this design; the user decides what claim the MVP should rest on (accuracy at lower citation-verification cost, latency, or a different token framing).
- **Inconclusive** otherwise: 0.85 < R < 1.10, or adoption below 20% (routing, not corpus, is then the problem; the next step is adoption work, not a registration), or correctness of either arm below 50% on the audited keys (the keys or the wording are the problem), or more than 3 of 16 keys changed by the audit after calibration.
- Report the per-category pattern (callers and references against heritage and impact) whatever R is; `impact` was 0/32 correct in every arm on gsd-core, so a pilot impact result mainly tests the key.

## 7. Work breakdown

| # | task | owner | depends on | effort |
| --- | --- | --- | --- | --- |
| 1 | oracle prototype and census (done in this note, `scripts/angular-pilot/`) | agent | | done |
| 2 | decide scope and counting rules (section 3, tests in or out, 16 questions) | user | 1 | 0.5 h |
| 3 | oracle completion: impact depth two, alias handling in `references`, `file+line` for definition, a `callers`-through-`any` audit for compiler-cli and language-service targets, a spec-file scope option in `sample-keys.ts`; unit tests first | agent | 2 | 1 to 1.5 days |
| 4 | question generation by the selection rule, wording with counting rules, abstain names (zero whole-word hits) | agent | 2, 3 | 0.5 day |
| 5 | key audit: per question the compiler key against `git grep`, every disputed file read, alias and re-export cases; second reader (a different agent) on a sample; user reviews the question list | agent then user | 4 | 1 day agent plus 1 h user |
| 6 | driver changes: angular corpus and question files, `prepare-checkout.ts` (strip list and record), three-condition schedule with seed, key-file plumbing; tests first; no edit to the registered harness | agent | 4 | 0.5 to 1 day |
| 7 | closed-book control and calibration batch (12 sessions), then re-read the cost model and the stop lines | agent runs, user watches limits | 5, 6 | 0.5 day |
| 8 | pilot run in chunks of 16 with checks | agent runs | 7, user go | 0.5 day wall, mostly waiting |
| 9 | audit against session answers (the gsd-core lesson: extra files in sessions may be real hits), then analysis note with R, correctness, adoption, per category, against the decision rules | agent | 8 | 0.5 to 1 day |
| 10 | decision on a registered run | user | 9 | |

Oracle effort: `corpus-candidates.md` guessed 1 to 3 days. With the prototype done, the pilot needs about 2.5 to 3.5 agent-days for oracle completion, questions and audit (tasks 3 to 5); the 50-plus registered set adds about 3 to 4 days (more candidates to audit, impact and methods, a second package set if callers run short, wording review) and a preregistration stage.

## 8. Risks and limits

- **Contamination.** Angular is among the most public repositories; 264 of the 328 window declarations were first added before 2024 (history clone), so definitions and many heritage relations may be memorised. Mitigations: pin is 2026-10-21, 241 of 328 declaring files changed since 2026-01-01 (161 since June 2026) and the selection rule prefers them; the closed-book control measures memory directly; callers and references keys depend on the exact current tree, which memory cannot reproduce. The model's training cutoff is not known to me precisely (the environment states June 2026). Contamination cannot be removed; it affects both arms alike, so it biases correctness comparisons toward equality and tokens toward fewer search turns in both.
- **Oracle `any` limits.** 14% of files import the unresolved `typescript` package and 4.5% `rxjs`; hits that reach angular code through `any`-typed values are missed by the key and may be found by sessions. Mitigation: audit by `git grep` plus reading, restrict pilot targets to packages whose uses do not flow through `ts.*` values where possible, record the residual.
- **Atlas index cost.** About 85 s and 5 GB per index; one failure (`source_too_large`) and a build-time resolver timeout that `maintain resolve` completes. A registered run of 450 sessions would spend about 5 h on indexes unless the store is reusable (unverified).
- **Atlas recall on aliased type references** (2 of 6 on the `DirectiveMeta` sample) will cost atlas correctness in `references` and some `heritage` questions; that is a finding, but it can make the token comparison unfair if only correct answers are valued. Report tokens with and without incorrect sessions.
- **Angular templates and decorators.** Scope has 2 inline-template components and 7 `.html` files; templates are excluded by rule. 89 `@Directive`/`@Pipe`/`@NgModule` and 69 `@Injectable` decorators are ordinary references to the compiler. If a later registration widens to `adev` or `devtools`, templates matter and need a rule and an oracle that reads them.
- **Bazel-generated sources.** Not in the tree. Imports of generated modules would be unresolved (not seen as a category in the unresolved list, but only imports are checked); `outDir` configs exist but `emit` questions are dropped.
- **Exact-set brittleness.** Key sizes up to 25 files; one missed barrel or spec file turns an otherwise right answer wrong. The matched/missing/extra counts are reported beside equality.
- **Window effect.** Inside the answerable window the corpus's grep cost is closer to gsd-core's than the survey headline suggests (section 2c); the premise check in section 6 is there for that reason. Methods are not in the supply measurement.
- **OS.** macOS arm64 only; Windows and Linux are not an issue for a read-only local pilot (no installs, no builds), and nothing was checked there.
- **Unverified:** whether a built index can be reused across session clones; `AGENTS.md` handling by Claude Code 2.1.305; a heritage path for atlas sessions; adoption under `atlas-noskill-ts` beyond 0/4; the real grep-session token multiplier; the Max-allowance cost of 96 to 124 sessions; method-level supply; impact depth two supply; how many tail targets run through `any`; the oracle on the 50-plus set.

## 9. Decisions the user must make

1. Adopt, change or reject the section 6 numbers (R thresholds 0.85 and 1.10, correctness margin 0.10, adoption 50%, premise floor 68k and 55k).
2. Tests in scope (recommended) or out.
3. Three conditions (G, A-ts, A-reg; 96 sessions) or two (G, A-ts; 64 sessions, about 35% cheaper).
4. Installed Claude Code 2.1.305 (recommended) or a pin to 2.1.302.
5. Notional cap 30 USD and the Max-allowance stop at 0.60, or lower.
6. Strip list for agent-config files (section 4), including the root `skills/` directory.
7. Whether to spend the closed-book control (about 0.5 USD) and the 12-session calibration batch before the pilot (recommended: yes).
8. Whether a later registration would widen beyond `packages/` or add methods to reach 50 callers; that is a design decision for after the pilot.

## 10. Decisions taken (2026-10-21, by the owner)

1. Decision rules adopted as proposed in section 6: worth registering an angular run if R <= 0.85, correctness >= grep minus 0.10 and atlas adoption >= 50%; reconsider the token gate if R >= 1.10 for both atlas conditions; premise holds only if the grep mean is >= 68k billable tokens (below 55k it failed); everything else inconclusive.
2. Spec/test files are in scope for the questions.
3. Three conditions (G, A-ts, A-reg), 96 sessions, on the installed Claude Code 2.1.305; the pilot's numbers are never compared with the registered run's absolute numbers.
4. The 12-session calibration batch and the closed-book control are both run before the pilot.
5. Not chosen explicitly: the notional cap. The Max-allowance stop at 0.60 (five-hour and seven-day), overage off, no API key, and the sequential/nice rules stay as standing safeguards (as in the probes); the 30 USD cap is a ceiling the owner confirms before the full pilot runs, after the calibration batch has measured the real grep cost.
6. Not decided yet, taken at the plan's recommendation until changed: the strip list of agent-config files (section 4); widening beyond `packages/` or adding methods is a design decision for after the pilot (section 9, item 8).
7. Ordering: the pilot's atlas arm runs only after the indexer ignore-rules quick task (261021-re7) has merged, so that the file set indexed for angular is the one a user would get; no model session is run before then.
