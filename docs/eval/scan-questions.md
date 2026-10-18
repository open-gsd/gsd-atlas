# Free-alternatives scan questions

These eight questions are asked of every free tool in [free-alternatives.md](free-alternatives.md). They are not the scored eval question set (EVL-02) and the scan produces no ranking. The machine form, with the oracle's answer key embedded for each question, is `scripts/eval/scan-questions.json`.

## How they were drafted

- From gsd-core source and ADRs at the pinned commit `10ac3a7a947903ba50f538a907af036744d759d5` (`corpora/corpora.json`), read with `git grep`, `grep` and the reading tools only. Neither atlas nor any other code-intelligence tool was used to choose or phrase them.
- Each answer key comes from the independent oracle (`scripts/eval/oracle.ts`, version 03-04.1), which uses the TypeScript compiler and git and nothing of the tools under test. `node scripts/eval/scan.ts embed-keys --repo <checkout>` recomputes and embeds the keys.
- Marking is file-level: an answer is `yes` when every file in the key is named and nothing else is, `partial` when some are, `no` when none are or the tool answered where the key abstains. This is a scan-only check; the scorer of the eval (plan 03-07) does not exist yet and is not used.
- Two wording changes were made before the committed runs, both while the questions were still scan-only: the first draft of s-008 probed `ADR-2481`, which turned out to be an issue number with an amendment recorded in ADR-1239, so a careful answer was not clearly wrong; it was replaced by a symbol that does not exist. The first draft of s-006 did not say that test files count, so one model excluded them; the sentence was added and every tool's run uses the final wording. The first-pass codegraph run was discarded and rerun in full.

## The questions

| Id | Category | Question |
|----|----------|----------|
| s-001 | callers | Which files contain a call to `ensureCommonJsMarker` exported from `src/commonjs-marker.cts`? Include tests and plain JavaScript files. A function with the same name declared elsewhere is not that function, but a file that calls the one from `src/commonjs-marker.cts` under another name still counts. |
| s-002 | callers | Which files call `parseNamedArgsOrExit` from `src/command-arg-projection.cts`? List each file once, including plain JavaScript files. |
| s-003 | heritage | Which interfaces extend `ModelAdapter` declared in `src/model-adapter.cts`? Give the file and the interface name of each. |
| s-004 | emit | The TypeScript build compiles `src/commonjs-marker.cts` to a CommonJS `.cjs` file. Which plain JavaScript files (`.js` or `.cjs`) in this repository `require` that compiled file? |
| s-005 | adr | Which files cite ADR-58 in a code comment? List every file that does, including tests and scripts. |
| s-006 | impact | If the return shape of `composeWithinBudget` in `src/context-composer.cts` changed, which files would be affected, either because they call it directly or because they call a function that does? Include test files and plain JavaScript files. List each file once. |
| s-007 | definition | Where is `normalizeRelPath` defined? List every file that defines a function with that name. |
| s-008 | abstain | Where is the function `reconcileWorkstreamLocks` defined, and which files call it? If this repository has no such function, say so. |

## What each question probes

- **s-001, s-002 (callers).** Callers that live in `.cjs` and `.js` files reach a `.cts` definition only through the build's emit mapping; s-001 also has a same-named local function in another file.
- **s-003 (heritage).** Interface-extends relations inside one TypeScript file.
- **s-004 (emit mapping).** `.cts` to `.cjs`: the consumers are plain JavaScript files that `require` the emitted output.
- **s-005 (ADR citations).** The citations are comment text; the answer lives in the link between code and the ADR number, not in a symbol.
- **s-006 (impact).** Two hops of callers, across `.cts`, `.cjs` and test files.
- **s-007 (definition).** The name is declared in four files, one of them exported.
- **s-008 (abstain).** The symbol exists nowhere in the repository (the oracle refuses a probe that matches any tracked file).

## Symbols the scored question set must not reuse

The scored set (plan 03-09) is disjoint from this one. Its author excludes these names and files as the subject of any question: `ensureCommonJsMarker`, `parseNamedArgsOrExit`, `ModelAdapter`, `src/commonjs-marker.cts` (as an emit source), ADR 58 (as an `adr-citers` subject), `composeWithinBudget`, `normalizeRelPath`, `reconcileWorkstreamLocks`.
