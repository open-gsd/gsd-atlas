# Plan section 12: round 3, real SDK pack (macOS 27), pre-registered 2026-10-28

Status: frozen before any round 3 target is drawn and before any round 3 query is written or any retrieval arm is run on this pack. Edits after the hash is recorded are amendments in `FREEZE.md`.

## 12.1 Purpose

Rounds 1 and 2 used `@types/node` and TypeScript `lib.*.d.ts` as stand-ins. Round 3 repeats the confirmation on a real platform SDK: the installed macOS 27 SDK. Questions: does the EmbeddingGemma 2 lane lift recall over a stronger lexical baseline on real SDK declarations, including APIs introduced in macOS 27 that no model has seen in training; does it stay non-inferior on identifier queries; what does the full pack cost to index and query on this Mac.

## 12.2 Pack (pinned)

- Source: `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX27.0.sdk`, Xcode 27.1 build 27A9275. No network.
- Part `objc`: Objective-C and C headers under `System/Library/Frameworks/*.framework/Headers` (symlinks resolved, each real file once). Header doc comments and `API_AVAILABLE`, `API_DEPRECATED`, `NS_AVAILABLE_MAC`, `NS_DEPRECATED_MAC` macros are read.
- Part `swift`: `arm64e-apple-macos.swiftinterface` of every framework module (192). `@available` lines are read. Swift interfaces carry no prose documentation, so `swift` declarations have only name, owner, signature and availability.
- Excluded frameworks: `Kernel`, `DriverKit` (kernel-space headers, not application SDK surface).
- Extraction is a heuristic line parser (`extract-sdk.mjs`), not a compiler front end. Counts are reported; extraction errors are a stated limitation, not corrected after targets are drawn.
- Document text for dense arms uses the same `docText` as rounds 1 and 2. Availability text (`macOS 27.0+`, `deprecated macOS 15.0`) is part of `sig`, so both lexical and dense arms see it.

## 12.3 Query sets

- **V3** (vocabulary gap, written by fresh AI agents that have seen no results and no model output, as in round 2): at least 150 accepted queries. Target strata, drawn with seed 41 from declarations whose (framework, owner, name) is unique and whose name occurs at most 3 times in the pool, name length at least 4, excluding `init`, `hashValue`, `description`, `==` and similar boilerplate names:
  - **A**: objc, documented (doc at least 60 characters), introduced before macOS 27. 70 targets.
  - **B**: objc, documented, introduced in macOS 27. 40 targets (all if fewer exist).
  - **C**: swift, introduced in macOS 27 (no prose documentation). 60 targets.
  - **D**: swift, introduced before macOS 27. 30 targets.
  - Reserve draws of 10 per stratum (seed 43) are used only to reach the minimum after rejections.
- **I3** (identifier queries, generated mechanically, seed 42, no model involved): 90 queries over the rules exact, qualified, fragment, lowerjoined, misspelled, moduleMember, targets with a pool-unique name, at least 6 characters, at least 2 camel-case parts, half objc and half swift, disjoint from V3 targets.
- Authors are told only the target declarations (name, owner, framework, declaration, documentation if any, availability) and the rule: describe what an agent would ask for in words that do not appear in the name, owner or framework. The text-only overlap checker of round 2 (name piece, 34 percent share, 5 to 18 words) rejects queries; rejected queries are dropped, not repaired.
- Tuning/test split: `fnv1a(kind|id) mod 10 < 3` is tuning, else test, as in round 2.

## 12.4 Arms

All run on the full pool.
- `F`: round 1 FTS5 trigram bm25 (unchanged).
- `F2`: stronger lexical baseline: FTS5 `porter unicode61` word index over name, nameSplit, qual, doc, sig; query is the OR of stemmed content words; weights name 6, nameSplit 4, others 1.
- `L`: whichever of `F` or `F2` has the higher V3 recall@10 on the tuning half (fixed before the test half is scored).
- `D`: dense only (normalised vectors, exact cosine, top 50).
- `E`: RRF(L, D) k 60; `W2`, `W3`: weighted RRF with dense weight 2 and 3.
- `R1`: syntactic identifier test sends the query to L, else `E/W`. `R2`: if the top hit of L equals the query as an exact (case-insensitive) name, qualified name or framework.name, send to L, else `E/W`.
- **Primary arm: R2 with the dense weight tuned on the tuning half** (mean of V3 and I3 recall@10 of R2(w), w in 1, 2, 3). Fixed in advance.
- Models: EmbeddingGemma 2 (llama.cpp Metal, the round 2 GGUF, same prefixes), Qwen3-Embedding-0.6B (Metal), bge-small-en-v1.5 (Metal). Primary model for conditions: EmbeddingGemma 2.

## 12.5 Pass conditions (EmbeddingGemma 2, Mac, test halves)

- **C1**: V3 test recall@10 of primary minus L is at least +5 points and the paired bootstrap (10,000 resamples, seed 42) 5th percentile is above 0.
- **C2**: in each stratum A, B, C, D (test halves), primary minus L has a non-negative mean difference. Stratum C (macOS 27 Swift, no docs) is reported with its own bootstrap interval; if a stratum has fewer than 15 test queries it is reported as indicative and the condition is judged on the pooled B plus C.
- **C3**: I3 test recall@10 of primary is at most 1 point below L.
- **C4**: two full runs on Metal give identical top-10 lists for all queries (determinism).
- **C5**: a network-denied run (`sandbox-exec` deny network, offline env vars) reproduces identical top-10 lists, with document vectors rebuilt inside the sandbox on a fixed random 5,000-document sub-pool plus all gold documents (the full pool is too slow to re-embed twice); the check compares dense top-10 within that sub-pool against a non-sandboxed run on the same sub-pool.
- **C6**: portability: ONNX CPU (transformers.js, q8) over a fixed sub-pool (all gold documents plus the union of Metal dense top-50 lists plus 5,000 random documents) agrees with Metal on the same sub-pool within 1 point recall@10 and at least 0.9 mean top-10 overlap.
- **C7** (budget, user default): full-pack embed time on Metal at most 10 minutes; added query p95 (query embed plus exact scan plus FTS) at most 50 ms warm on the full pool. Both are reported against the pool actually measured. Failure here does not void C1 to C3; it selects the scoping work in 12.7.
- **C8**: storage: bytes for the full pool at float32 768, int8 768 and int8 256 are reported against the A18 budget as recorded in round 2.

## 12.6 Decision rule

- If C1, C2, C3 pass: the lane is confirmed on a real SDK pack. C4 to C6 failures are named blockers for the product phase.
- If C1 passes but C2 or C3 fails: confirmed only for the strata where it passed; the router or scope is restricted accordingly.
- If C1 fails: the round 2 result does not transfer to a real SDK pack and the proposal records negative evidence for this slice.
- Whatever the outcome, the result is reported with the weak-baseline caveat re-evaluated against `F2`.

## 12.7 Scoping measurements (descriptive, no pass/fail)

- **Pool-lite**: objc declarations with doc at least 40 characters, plus all declarations (either part) introduced in macOS 26 or later. Report its size, the share of V3 and I3 gold documents inside it, and the projected embed time and storage.
- Per-part (objc, swift) and per-framework-group breakdowns of V3 test recall@10.
- A comparison with Xcode's `DocumentationSearch` MCP tool is limited to a small spot check (at most 10 queries), reported as anecdotal; its output is too large for a bulk run.

## 12.8 Limitations stated in advance

All queries are written by AI agents of one model family; the extraction is heuristic; the Swift part has no prose; the pack is macOS only; Windows and Node 24 are untested; exact numbers on this pack will not be the numbers on the product's own SDK pack.
