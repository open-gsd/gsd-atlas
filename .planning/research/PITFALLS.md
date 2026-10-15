# Pitfalls Research

**Domain:** Local code-intelligence + platform-SDK-facts server for coding agents (tree-sitter WASM grammars, `node:sqlite` fact store, file watcher, TypeScript compiler adapter, MCP/CLI/Skill/hooks, cross-OS CI, agent eval), built solo plus agents
**Researched:** 2026-10-15
**Confidence:** MEDIUM overall. HIGH where a primary source was fetched (TypeScript 7 announcement, MCP spec-change coverage, SQLite documented behavior). MEDIUM where only issue trackers or blogs back a claim. Items tagged `[UNVERIFIED]` come from general knowledge or a single weak source and need a spike before they drive a decision.

**Scope note:** `docs/DESIGN-REVIEW.md` already resolved 47 findings (F-1..F-6, ST-1..4, LM-1..5, SDK-1..4, L-1..4, H-1..6, M-1..5, S-1..4, E-1..3, O-1..3, P-1..3). This file does not repeat them. It covers what the review did not: stale or contradicted external assumptions (Part A), implementation traps in the chosen stack (Part B), and process/scope/eval traps (Part C). Where a pitfall extends a review finding, the ID is cited.

**Roadmap labels:** M0..M6 and M2.5 are the PRD §14 milestones.

---

## Part A: Assumptions in the PRD that external evidence contradicts or weakens

### Pitfall A1: The TypeScript 7 "native `unstable/sync` API" adapter targets an API that did not ship

**What goes wrong:** PRD §12 and M2 plan a 7.x PreciseResolver adapter over `typescript/unstable/sync|async`. TypeScript 7.0 reached GA on 2026-07-08. Microsoft's own announcement says: "While TypeScript 7.0 is here, it does not ship with an API", "TypeScript 7 does not yet expose a stable programmatic API", and "We expect TypeScript 7.1 to ship with a new (and different) API". I found no source documenting a `typescript/unstable` entry point in 7.0 (not verified either way, so check the typescript-go repo in the M2 spike). The PRD's "project's own `typescript` package" assumption also breaks. A project on TS 7 has no `ts.createProgram` or `ts.createLanguageService` to load. Microsoft published `@typescript/typescript6`, which re-exports the 6.0 API next to a 7.x `tsc`, so some projects will have both and some will have only 7.
**Why it happens:** The design was written against the typescript-go repo's in-flight API, which reads as "the 7.x API". It was never checked against the GA release.
**Consequences:** M2 blocks on an adapter that cannot be finished. gsd-core is on TS 6.0.3 today and its upgrade path is unplanned. When it moves to 7, "load the project's own typescript" returns an object with no compiler API.
**How to avoid:**
- Make the M2 gate TypeScript 6.x only. Treat the 7.x adapter as a stretch item gated on TS 7.1 shipping a documented API.
- Version-detect the project's `typescript` by reading `package.json`. Do not `require` it just to find out. If it is 7.x with no usable API, fall back in this order: project's `@typescript/typescript6` if present, then a bundled 6.x (`degraded: compiler_version_mismatch`), then the grammar tier.
- Remember TS 7 makes the 6.0 deprecations hard errors (`baseUrl`, `target: es5`, `node10`/`classic` resolution, `downlevelIteration`) and makes `strict` the default. Bundled-6.x results on a TS 7 project's tsconfig may differ. Surface this in `explain`.
- Do not take `typescript` 7.x as a dependency. Keep an adapter conformance suite so 7.1 can plug in later.
**Warning signs:** The M2 spike cannot find a stable import path for the 7.x API. The adapter code is more than 50% IPC protocol reverse-engineering. Failures on a TS 7 fixture all say "createProgram is not a function".
**Phase to address:** M2 spike (week 1) and PROJECT.md "Unstable dependencies". Re-check when 7.1 ships.
**Confidence:** HIGH on "7.0 has no API" (Microsoft devblog + InfoQ). LOW on whether any `unstable` entry exists.

### Pitfall A2: MCP moved to a stateless protocol on 2026-07-28; the design assumes sessions

**What goes wrong:** DESIGN A23 counts "an MCP session" as per-agent state and PRD §11.1 plans "drain and replace" host upgrades. Third-party coverage of the MCP 2026-07-28 revision says it removes the `initialize`/`initialized` handshake, the `Mcp-Session-Id` header and protocol-level sessions. Version and capability data move into `_meta` on every request. A `server/discover` method is added. This is secondary-source coverage; read the official spec for wire details. Clients and SDKs will straddle both revisions for a long time. Separately, Claude Code's Streamable HTTP client has repeatedly failed to re-initialize after a server restart returns 404 "Session not found" (issues #27142, #60949, #62008, #75976, the last on v2.1.205 in July 2026). The tools go silent while the UI still shows the server as connected.
**Why it happens:** The Host is designed to restart often (supervisor, watchdog, minor-version upgrades). Every restart on a sessionful transport strands clients that handle 404 badly.
**Consequences:** After every host restart or upgrade, agents silently lose atlas until the user restarts their agent. With the fail-open hooks the symptom is "atlas stopped helping" with no error. This is the same silent-failure mode H-4 worried about, via a different cause.
**How to avoid:**
- Make the host stateless by default on HTTP. No state may be required to answer a request beyond what a request carries. The session ledger stays an optimization (see B9).
- Pin the MCP SDK and run the conformance suite against both the 2025-11-25 and 2026-07-28 behaviors. If the SDK picks the version, test it explicitly.
- Do not use HTTP MCP for Claude Code until its re-initialization bug is closed. Make the stdio shim the default registration. The shim owns reconnection to the host, so the agent's session never sees a host restart. Test by killing the host mid-session and checking that the next tool call succeeds.
- Add a CI test: restart the host between two tool calls on the same client connection, for each supported client transport.
**Warning signs:** "Session not found" in logs. Tool calls that hang after an upgrade. Any design sentence of the form "the session remembers".
**Phase to address:** M1 (transport choice, shim reconnect); M2.5 (HTTP/socket transport and protocol versioning).

### Pitfall A3: The eval's "beats grep" success criterion may be unwinnable on accuracy, and the PRD's ground truths are circular

**What goes wrong:** Three separate traps sit in PRD §2 and criteria 1, 2.
1. *Direction of effect.* The one peer-style evaluation I found of a tree-sitter + MCP graph server (Codebase-Memory, arXiv 2603.27277, as summarized in search results; PDF body not readable) reports 0.83 answer quality for the graph agent vs 0.92 for a grep-and-read explorer, with about 10x fewer tokens and about 2x fewer tool calls. The same report says the graph is weakest where syntax is hard (macro-heavy C). An independent group also flagged another tool's "99.2% token reduction" for using a naive grep baseline. Separately, a faster-search MCP server cut search latency 14.7ms to 1.7ms but end-to-end agent time only moved 38.6s to 37.0s. The likely honest result for atlas is non-inferior accuracy plus fewer tokens and calls, not higher accuracy.
2. *Circular ground truth.* "Per-construct recall ≥ 90% against a tree-sitter ground truth (grammar tier)" measures the tree-sitter extractor against tree-sitter.
3. *Self-consistency is not correctness.* Criterion 2 ("each cited line lies inside the fact's span") proves atlas agrees with itself. A fact with a wrong span passes.
**Why it happens:** The builder writes questions, extractors and oracles. Each is shaped by what atlas can do.
**Consequences:** M2's gate ("eval beats grep-only") fails or passes for the wrong reason. The project either stalls at the gate or ships a metric that does not mean anything.
**How to avoid:**
- Split the success metric in PROJECT.md and the roadmap. Accuracy non-inferiority (paired, with a margin) is the correctness claim. Tokens, tool calls and wall time at equal accuracy are the benefit claim. Do not require "higher accuracy than grep" as the gate.
- Use an independent oracle. For TS, use the compiler symbol table (already planned). For the grammar tier, use a hand-labeled sample of 100+ constructs per language, or ctags/ripgrep patterns as a cross-check. Never grade tree-sitter against tree-sitter.
- Verify citations independently. Check out the pinned SHA, read the cited line from disk, and compare it to the expected answer. Do not use atlas's own span.
- Make the baseline the strongest realistic one: the host agent's native tools (ripgrep, Read, Glob, its built-in explore subagent), the same model, the same turn and token budget, and the same prompt except for the atlas tool and skill. A weak grep baseline inflates the headline. A hobbled atlas arm (no `Read`) deflates it.
**Warning signs:** An eval question whose answer was found by running atlas. Atlas arm and grep arm differing in model, budget or prompt text. Recall measured with the same query files used to extract.
**Phase to address:** Free-alternatives scan (before M1); eval harness design (M2); M5 re-run on all four corpora.

---

## Part B: Implementation traps in the chosen stack

### Pitfall B1: web-tree-sitter objects are manually freed, and WASM linear memory never shrinks

**What goes wrong:** web-tree-sitter `Parser`, `Tree`, `TreeCursor`, `Query` and `Language` objects live in WASM memory. They are not freed unless you call `.delete()` (a FinalizationRegistry proposal exists but was not confirmed implemented). Repomix 1.16.1 fixed exactly this: parsed Trees were never released and memory grew on large repos. WASM linear memory can grow but not shrink, so one 20 MB generated file raises the worker's resident size for the rest of its life. The review's nightly soak ("return to baseline") will fail if baseline means RSS with WASM workers in the loop.
**Why it happens:** JS developers expect GC. Tree-sitter's API reads like plain objects. Exceptions thrown mid-parse skip the cleanup lines.
**Consequences:** Slow memory growth in a daemon that is supposed to live for days. Under the Governor's memory budget, a leak looks like "compilers use too much" and the wrong LRU gets evicted.
**How to avoid:**
- Wrap every parse in one function: `withTree(src, fn)` that deletes the tree, cursor and query matches in `finally`. Lint-ban direct `parser.parse` outside it.
- Reuse one Parser per language per worker (setLanguage is cheap, constructing is not).
- Pool workers with recycling: restart a parser worker after N files or when its WASM heap exceeds a threshold. Cap parsable file size (skip or line-chunk beyond ~1-2 MB; minified bundles are the usual culprit).
- Run parses off the main thread. A long parse blocks the event loop and breaks hook latency budgets (B6).
- Add a soak test that parses the same 1,000 files 100 times in one worker and asserts a flat heap.
**Warning signs:** RSS of a parse worker rising monotonically with files parsed. Memory that returns to baseline only after a worker restart.
**Phase to address:** M0 (Grammar Engine seam, wrapper and lint rule); M1 (pool, recycling, soak).
**Confidence:** MEDIUM (Repomix release note + web-tree-sitter API surface). The WASM no-shrink behavior is general knowledge.

### Pitfall B2: Grammar `.wasm` and runtime ABI skew, and `hasError` is the wrong quality metric

**What goes wrong:**
- *ABI direction.* The tree-sitter runtime accepts languages built by older CLIs, not newer ones. web-tree-sitter 0.25 was a rewrite in TypeScript and moved to ABI 15, and 0.25.2 fixed a crash when loading WASM grammars generated by earlier CLIs. A routine bump of either side can make `Language.load` fail or crash. Upstream grammars ship `parser.c` generated by arbitrary CLI versions.
- *Build toolchain.* Building `.wasm` needs a C-to-WASM toolchain (emscripten, docker or wasi-sdk depending on CLI version). That toolchain differs by OS and CI image, so "grammars are built from pinned upstream by our own build" can pass on a laptop and fail on the Windows runner. `[UNVERIFIED: exact toolchain requirement per CLI version]`
- *Wrong metric.* The 0.5% budget is "files with parse errors". One ERROR node in a 3,000-line file counts the same as a file that lost its second half. The measured regressions (regex literal containing `<!--`, `import('./x.cjs').Type`) lose everything after the error point only sometimes.
- *Extension to grammar mapping.* TypeScript has separate `typescript` and `tsx` grammars. `.cts` and `.mts` use the `typescript` grammar. `.ts` files containing `<T>expr` casts fail under `tsx`. A `.tsx` file under the `typescript` grammar fails on JSX. A manifest with only `extensions` per grammar cannot express this.
**Why it happens:** Grammars are versioned like data but are generated code with a hard ABI contract.
**Consequences:** Silent coverage loss (definitions after an error vanish) or a startup crash after a dependency bump.
**How to avoid:**
- Pin the runtime, the CLI used to build every grammar and the grammar commits in one lockfile-like manifest. A CI job loads every built grammar with the shipped runtime and runs its fixtures. A grammar that fails to load is skipped at runtime with a diagnostic, never fatal.
- Commit or cache the built `.wasm` artifacts by hash. Do not rebuild on every OS in every CI run. Verify the hash in CI.
- Measure error damage, not file counts. Report per file the fraction of bytes inside ERROR/MISSING nodes and the number of top-level declarations after the first error. Gate on "files with >2% bytes in error" and on recall of the declarations that follow.
- Let the manifest map by extension and optional sub-grammar (`.tsx` to `tsx`, `.ts` to `typescript` with a `tsx` retry on error).
- Wrap `Language.load` and query compilation in a startup self-test: a bad `.scm` query fails at module load, not at the first matching file.
**Warning signs:** "Incompatible language version" or a WASM trap at startup after a dependency update. Parse-error rates that differ by OS. Query files that compile on one runtime version and throw on another.
**Phase to address:** M0 (grammar build pipeline and pin set); M1 (error-damage metric); M3 (Swift 6.x grammar fixtures: macros, typed throws, noncopyable types; upstream 0.7.1 dates from June 2025).
**Confidence:** MEDIUM. The exact error string was not found in sources.

### Pitfall B3: `node:sqlite` is synchronous, its edges differ from `better-sqlite3`, and some Node builds have a TEXT truncation bug

**What goes wrong:**
- *Blocking.* `DatabaseSync` blocks the calling thread. A trigram FTS query or a large `code_impact` expansion on the event loop stalls every concurrent request and the hook endpoint, which has a 20 ms p99 budget.
- *Known decoder bug.* A compatibility note reports that the `node:sqlite` TEXT decoder in Node 22.23.x, 24.15.0, 25.9.0 and 26.0.0 silently truncates values at an embedded NUL character, fixed in 24.16.0 and 26.1.0. Atlas stores source-derived text. The development machine (Node 26.11.1) is past the fix, but "Node >= 24" users are not. One secondary source. `[UNVERIFIED against Node release notes]`
- *Option drift.* Some newer `DatabaseSync` options exist only on Node 25+ and are silently ignored on 24. Defaults you rely on (defensive mode, extension loading) can differ by minor version.
- *Driver parity.* The conformance suite must cover error mapping (how `SQLITE_BUSY` and constraint errors surface), BigInt handling, parameter binding and row shape (reported null-prototype rows vs plain objects), not only SQL results. `better-sqlite3` "kept working" will rot if only exercised on a nightly job.
- *FTS5 trigram limit.* Documented SQLite behavior: the trigram tokenizer cannot match queries shorter than 3 characters. Short symbols (`fs`, `id`, `ts`, `h`, `$`) will not be found by `MATCH`. The ST-1 fix (use FTS5 trigram) needs a short-name path.
**How to avoid:**
- Run all reads in worker threads with one connection per thread (a read pool) and the single writer in its own thread. The Fact Store interface returns promises.
- Assert `SELECT sqlite_version()`, driver and Node version on open. Refuse a Node build on the known-bad list or run a startup self-test: write and read back text with an embedded `\0`.
- Add driver-parity tests that run on every PR, not nightly.
- Exact-match short names via a normal index, fuzzy via FTS5 only for 3+ characters.
**Warning signs:** Event-loop lag over 10 ms in the host under load. Query results shorter than stored text. `code_find("fs")` returning nothing.
**Phase to address:** M0 (driver seam and conformance suite); M1 (worker pool, FTS short-name path).
**Confidence:** MEDIUM.

### Pitfall B4: WAL pitfalls beyond the review (first-open race, Windows busy handling, checkpoint starvation, containers)

**What goes wrong:**
- *First open in WAL on Windows.* When several connections or processes open a fresh database at once and one converts it to WAL, SQLite returns `SQLITE_BUSY` immediately for the exclusive-lock upgrade and does not call the busy handler, so `busy_timeout` does not help. On Windows (mandatory file locking) the losers surface "database is locked". A Rust project documents this and retries in application code. Source is a Rust codebase, but SQLite semantics are shared.
- *Windows lock semantics.* SQLite developers state the win32 VFS uses `LockFileEx` in fail-fast mode, so contention returns `SQLITE_BUSY`; short busy timeouts become flaky under heavy concurrency on Windows.
- *Checkpoint starvation.* WAL can only reset when no reader is mid-transaction. With many agents, long-lived read snapshots (a paginated `more` cursor that keeps a read transaction open) keep the WAL growing. The `TRUNCATE` checkpoint in Compact may never win. This is documented SQLite behavior.
- *Second writer.* "One writer per store" breaks when `gsd-atlas build`, `maintain` or `bug` run from the CLI while the host is running. WAL permits many readers but one writer; the CLI will simply fail with `SQLITE_BUSY`.
- *WAL needs shared memory on one host.* Repos opened from a devcontainer or VM bind mount (macOS host plus Linux container on the same `.git`), or via WSL2 `/mnt/c`, put two kernels on the same `-shm`. SQLite's docs say WAL does not work across machines or network filesystems. Reports show "disk I/O error" on SMB or synced folders.
- *Detection limits for synced folders.* ST-2's "detect synced paths and move the store" is a heuristic. macOS Desktop & Documents iCloud sync and Windows OneDrive Known Folder Move redirect normal-looking paths (`~/Documents`, `C:\Users\x\OneDrive\Documents`), and Dropbox/Google Drive have their own roots. Missing one means a live `-wal` file inside a syncing folder.
**How to avoid:**
- Open sequence: try `PRAGMA journal_mode=WAL` in a retry loop with jittered backoff (5-10 attempts), under an advisory lock file that all atlas processes take before first-time init.
- Never run a second writer. CLI mutating commands either talk to the host or take the writer lock first and say so.
- Use short-lived read transactions only. Materialize a page, close the transaction, and make `more` cursors re-query by keyset. Add a gauge on WAL size and force a checkpoint at a threshold.
- Make the safe default conservative. Put the store outside the work tree (cache dir keyed by repo id) whenever the path is under a known sync root or the OneDrive/iCloud environment indicators are present. Add an open-time self-check (write a sentinel, check `PRAGMA quick_check`, verify the `-shm` is local).
- Detect containers/WSL mounts (`/mnt/c`, virtiofs, 9p, `fuse`) and use `journal_mode=DELETE` or refuse with a clear message.
**Warning signs:** `database is locked` in the first minute after install on Windows. WAL file larger than the main DB. Corruption reports that mention iCloud/OneDrive/Docker.
**Phase to address:** M0 (open sequence, writer lock); M1 (read transaction discipline, WAL gauge, store placement).
**Confidence:** MEDIUM-HIGH (SQLite docs and developer forum); container behavior is general knowledge.

### Pitfall B5: Watchers drop events silently, so "freshness < 1 s" needs a different floor

**What goes wrong:**
- *Windows:* `ReadDirectoryChangesW` has a fixed-size buffer. On overflow the call still reports success, the buffered changes are lost and no count comes back, so the caller cannot tell. Long paths (node_modules) shrink the number of events per buffer.
- *Linux:* inotify exhaustion shows up as `ENOSPC` ("no space left on device") with free disk. Docs and Chokidar recommend raising `fs.inotify.max_user_watches`. Containers share the host limit; WSL2 has its own. Ten repos with many worktrees and node_modules exhaust it quickly. Node's recursive `fs.watch` on Linux works by creating watches per directory.
- *macOS:* raw `fs.watch` does not report filenames reliably and misses some atomic-write editors (the chokidar README lists this).
- *Event storms:* `git checkout` across branches, `npm install` and agents rewriting 500 files via temp-file-plus-rename produce thousands of events. A bounded coalescing queue overflows. Without an overflow signal the Indexer thinks it is current.
- *Branch and worktree changes are not file events:* a worktree created anywhere on disk (swarm tools do this) does not emit events into the watched repo. `.git/HEAD`/index changes in linked worktrees live under the common dir.
- *Permissions on macOS:* a daemon spawned by an agent from a terminal may lose the terminal's TCC grants for `~/Documents`, `~/Desktop` or `~/Downloads`; it then gets `EPERM`/empty directory listings, indexes nothing, and appears healthy. `[UNVERIFIED: depends on how the host is launched]`
- *Antivirus:* real-time scanning slows file reads and SQLite writes on Windows and can hold files open. I found no direct source tying Defender to watcher loss, so treat as untested.
**How to avoid:**
- Treat events as hints, never truth. Every overflow, error, `ENOSPC` and resume-from-sleep triggers a scoped Reconcile (`git ls-files -s` plus `git status -z` mtimes and sizes). The review's Reconcile covers this; make it automatic on every overflow signal and on a timer (for example 30-60 s).
- Chokidar v4 or `@parcel/watcher` is easier to defend than hand-rolled `fs.watch`. Spike the choice on all three OSes using a storm test (create/rename/delete 5,000 files; 200 atomic rewrites) and assert the Indexer ends consistent.
- Poll worktree topology (`git worktree list -z`) and HEAD/index mtimes on a timer rather than relying on events.
- Report `watch_mode` (`native|poll|reconcile-only`), last overflow time and watch count in `status`.
- Make the freshness claim per-path-class: "agent's own edits are visible on the next call" (via `fresh`), "other writers within N s". Do not promise < 1 s for all events.
- Detect and warn on empty-index-after-permission-errors (zero files listed but `git ls-files` non-empty).
**Warning signs:** Missed-event repair count in `status` rising after branch switches. Index empty but `git ls-files` not. `ENOSPC` in logs.
**Phase to address:** M1 (Indexer, storm tests on three OSes); M2.5 (many repos and worktrees, watch budget).
**Confidence:** HIGH on inotify and Windows buffer behavior; MEDIUM on macOS details.

### Pitfall B6: Git plumbing at scale (process-per-file, lock contention, sparse and submodule entries, path encoding)

**What goes wrong:** Beyond F-3 (filters, CRLF, LFS):
- *Process-per-file hashing.* A design that runs `git hash-object --path` per file spawns thousands of processes. Process spawn on Windows is 10-50x slower than Linux; gsd-pi has ~3,900 TS files.
- *Index lock contention.* `git status` refreshes and rewrites `.git/index` opportunistically, taking `index.lock`. Background callers collide with the user's and the agent's commits. This is a documented reason for `git --no-optional-locks` / `GIT_OPTIONAL_LOCKS=0`, and Claude Code issues #47721, #50269 and #57102 show the same pattern with stale locks in worktrees. A swarm of hundreds of worktrees multiplies it.
- *Sparse checkout and `skip-worktree`.* `git ls-files` lists entries absent from disk. Treating them as deletions causes ENOENT storms and false retirements. Git docs also note tools can write outside the sparse set.
- *Submodules.* `ls-files` shows a gitlink (mode 160000) as a path. Treating it as a file fails on read.
- *Path encoding.* Without `-z`, git quotes non-ASCII and special paths with octal escapes (`core.quotepath`).
- *Case.* On macOS APFS and Windows, `core.ignorecase` makes git's recorded case authoritative for display, and a case-only rename (`Foo.ts` to `foo.ts`) can appear as no change on disk.
- *CRLF and spans.* With `core.autocrlf` or `.gitattributes eol=crlf` on Windows, the blob is LF and the working file CRLF. Hash by the git clean-filter output (A19), but then every offset, column and line-end must be defined against one text form (decide: working-tree bytes, since citations are read from disk). A UTF-8 BOM shifts column 0 by 3 bytes. tree-sitter reports byte offsets, and JS strings are UTF-16, so slicing a JS string with tree-sitter byte offsets breaks on any non-ASCII file.
- *Repo trust.* `git` honors `core.fsmonitor`, `core.hooksPath` and filter commands from `.git/config` and global config. `safe.directory` "dubious ownership" errors appear for repos owned by another user, Docker volumes or WSL paths.
**How to avoid:**
- Compute ids in batch: `git ls-files -s -z` for tracked-clean files and `git hash-object --stdin-paths` (or `git cat-file --batch-check` where valid) for dirty and untracked. Cap concurrent git processes.
- Route every git call through the CommandRunner with `GIT_OPTIONAL_LOCKS=0`, `-c core.fsmonitor=false`, `-c core.hooksPath=<empty>`, `-c core.quotepath=off` plus `-z`, and a safe-directory-aware error path ("repo not trusted by git" is a status, not a crash).
- Filter out skip-worktree entries (`git ls-files -v` tag `S`/`s`) and mode 160000 entries. Add them as fixtures in the Source Tree real-temp-repo tests.
- Store UTF-8 byte offsets and convert at the edge. Choose one text form and add a CRLF + BOM + emoji fixture that must round-trip spans on Windows CI.
**Warning signs:** Spawned git process count per second in the flight recorder. Users seeing "Unable to create index.lock" while atlas runs. Spans off by one on CRLF files.
**Phase to address:** M0 (Source Tree contract and fixtures); M1 (batching, locks, Windows CI fixtures).
**Confidence:** MEDIUM-HIGH (git docs and Claude Code issues); BOM/UTF-16 offset point is general knowledge.

### Pitfall B7: The TypeScript LanguageService is memory-hungry, uneven across monorepos, and its eviction is hard to make real

**What goes wrong:** One gsd-core program is about 357 MB (measured). Beyond LM-3:
- A "solution" tsconfig (`files: []` plus `references`) yields an empty program. gsd-pi has 14 tsconfigs; each package's program must be built separately, so memory multiplies by package count.
- `LanguageService.dispose()` does not guarantee prompt release. Old `SourceFile`s and type-check caches stay reachable via the document registry or your own references, so a count-based LRU says "evicted" while RSS says otherwise. I found no authoritative source documenting retention in `getProgram`; this is from general experience. `[UNVERIFIED]`
- Mis-parsing tsconfig (`ts.readConfigFile` without `extends` and `parseJsonConfigFileContent`) gives wrong `outDir`/`rootDir`, so the `emitted_as` mapping (criterion 4) is wrong for gsd-core's `.cts` to `.cjs`.
- The compiler is project code (`node_modules/typescript`). Loading it into the host process runs repo-controlled code outside the sandbox the PRD describes for CommandRunner-started adapters.
- Case-insensitive file systems: TypeScript follows the host's case rules; a path-case mismatch between atlas keys and compiler file names yields duplicate programs or "file name differs only in casing" diagnostics.
**How to avoid:**
- Run each compiler in a child process (not in-process, not a worker) with `--max-old-space-size` and RSS measured by the Governor. Evict by killing the process. That makes "bounded memory" real and sandboxing consistent.
- Parse configs with the project's own `ts.parseJsonConfigFileContent`, handle `references` and `extends`, and expand to the set of composite projects. Budget "programs per repo" as an explicit number.
- Pass the compiler's `useCaseSensitiveFileNames` from the OS volume and normalize paths at the edge (see B8).
- Test on gsd-pi's 14-tsconfig layout early in M2, not at M5.
**Warning signs:** RSS stays high after "eviction". `emitted_as` edges pointing into `outDir`. Two programs for the same tsconfig under different path casings.
**Phase to address:** M2 (spike on gsd-pi layout; child-process compiler); M2.5 (pool and budget).

### Pitfall B8: Windows host endpoint and path identity

**What goes wrong:**
- *Pipe name squatting and ownership.* A Windows named pipe name lives in a global namespace. If another process creates `\\.\pipe\gsd-atlas-...` first, a client that connects sends the bearer token to it. Node's `listen()` on an existing pipe fails with `EADDRINUSE` (a Claude Code native-host crash on Windows was exactly this). Windows removes a pipe when the owning process exits, so stale pipes are not the issue; a live second server is.
- *Unix socket paths.* Stale socket files remain after SIGKILL; they must be probe-and-unlinked under the election lock. Unix socket paths are limited to roughly 104 (macOS) or 108 (Linux) bytes; deep home directories or sandbox `TMPDIR`s can exceed that and fail with `EINVAL`/`ENAMETOOLONG`. `[UNVERIFIED limits per platform]`
- *Fixed loopback port fallback.* If another service owns the fixed port, a hook client sends `Authorization: Bearer <token>` to whatever listens. Token disclosure to an unrelated local process.
- *Path identity.* Drive letters differ in case between `process.cwd()`, `fs.realpath`, git's forward-slash output (`C:/...`) and tool output. A Rollup plugin issue and fix showed this exact class (`realpath` vs `resolve` returning different drive-letter case). Also 8.3 short names, junctions, `subst` drives and `\\?\` prefixes. A path-keyed store then holds duplicate repos.
**How to avoid:**
- Name the pipe/socket with the major version and the user identity (SID or uid) and put the identity proof in the handshake: the server proves it knows the token (challenge-response with HMAC), so the token never travels to an unproven listener. Prefer socket/pipe over TCP for hooks; for TCP fallback never send the raw token.
- Lock-file election, then probe-connect, then unlink (Unix). On `EADDRINUSE` on a pipe, connect as a client.
- Canonical path function used everywhere: `realpath.native`, uppercase the drive letter, forward-slash internal form, plus a per-volume case-sensitivity flag. Key lookups case-folded only on case-insensitive volumes; keep git's case-of-record for display. Fuzz it with a Windows CI test that passes the same repo via four spellings.
- Use the repo id (root commit + store id, L-4), never the path, as identity.
**Warning signs:** Two tenants for one repo on Windows. `EADDRINUSE` on startup after a crash. Hook client connecting to an unexpected process.
**Phase to address:** M0 (path module, CI); M1 (election); M2.5 (transport, handshake).
**Confidence:** MEDIUM-HIGH.

### Pitfall B9: Hook and enforcement loops: the 3-block cap depends on state the design says may be lost

**What goes wrong:**
- *The cap lives in an evictable ledger.* R4 ("max 3 blocks") and R2 ("one retry passes") count in the session ledger, which A37 defines as in-memory, expiring and "never required for correctness". After host restart or eviction the counter resets, so the agent can be blocked again without end.
- *Claude Code's own loop guards have been unreliable.* Issue #55754: a Stop hook returning `{"ok": false}` looped for about 50 minutes and consumed a session's quota. Issue #54360: `stop_hook_active` reported false on every fire within a turn. Do not depend on that flag as the only guard.
- *Schema drift.* PreToolUse output moved from top-level `decision`/`reason` to `hookSpecificOutput.permissionDecision` and `permissionDecisionReason`. Which events accept `additionalContext` differs, and I could not confirm it for PreToolUse. Exit code 2 blocks; other non-zero codes do not.
- *Timeouts.* Reports say the default hook timeout is 600 s since Claude Code 2.1.50. A hook that hangs while waiting on a cold host stalls every tool call for minutes. `[MEDIUM, third-party guides]`
- *Context bloat.* R1 "attach the atlas answer" adds tokens on every grep. The criterion says "total tokens no higher" but nothing keeps it true as the answer sizes grow. Also, 15+ MCP tool schemas are loaded into context every session; the PRD counts tool output, not tool-definition tokens.
- *Fixed-port or shim hooks on Windows:* the command-hook forwarder starts a process per call.
**How to avoid:**
- Fail open at every layer and decide it in tests: unknown or missing ledger entry means allow; host unreachable means allow in under the hook's own timeout.
- Persist the block counters outside the in-memory ledger. A small file keyed by session id with a TTL is enough. If the file cannot be read, do not block.
- Add your own cap that does not depend on `stop_hook_active`: block at most once per distinct finding set, and never block twice with an identical reason. Include an "override: user can say continue" path that the hook honors.
- Set explicit hook timeouts (1-2 s for gates, 5 s for advise) in the registered config. Measure round-trip with the daemon cold.
- Contract-test hook I/O per host against recorded fixtures for each supported version, and run a canary job against the latest host release.
- Count tool-definition tokens in the dashboard's "atlas's own cost". Keep descriptions short; measure session-start tokens with and without atlas.
- Gate rules by an A/B result: no rule ships in `enforce` until the eval shows tokens and completion rate non-worse with it on.
**Warning signs:** Same block reason appearing twice in one session. Hook p99 over its budget with a cold daemon. Hook latency in the flight recorder over the host's timeout.
**Phase to address:** M4 (hooks R0-R4; counters, timeouts, fixtures); M4 gate criterion 15 should include a loop-injection test (a host that always re-triggers Stop).
**Confidence:** MEDIUM-HIGH (open Claude Code issues; docs wording from third parties).

### Pitfall B10: MCP stdio shim hygiene and tool-output limits

**What goes wrong:**
- *Stdout pollution.* The most common cause of stdio MCP failures is non-protocol text on stdout: a logger, a dependency's `console.log`, a deprecation warning. It only fires on rare code paths, so tests pass. Embedded newlines in protocol messages and platform line-ending differences also break framing.
- *Startup race.* A shim that must spawn or wait for the host before answering `initialize` makes the client report the server as failed. The shim must answer `initialize` and `tools/list` immediately and connect lazily.
- *Orphans.* If the agent exits, a shim that ignores stdin EOF lingers. With a swarm of short-lived agents that is hundreds of node processes.
- *Output cap.* Claude Code rejects MCP responses over 25,000 tokens by default (`MAX_MCP_OUTPUT_TOKENS` raises it) with a pagination error rather than truncating, according to several non-Anthropic sources that disagree on truncate vs reject. atlas's `budget_tokens` (default 2,000) is well below that, but tokens are counted by the host's tokenizer, not atlas's, and envelope fields (citations, `debug` handles, `untrusted_text` fences, watermark) are easy to leave outside the budget.
**How to avoid:**
- At shim entry, redirect `console.*` to stderr or a file, replace `process.stdout.write` with a guarded writer that only accepts JSON-RPC frames, and set a lint rule banning `console.log` in `src/`.
- Test: spawn the shim, run a scripted session, assert every stdout line is valid JSON-RPC, on all three OSes and with `NODE_OPTIONS=--trace-warnings`.
- Keep the shim dependency-free and fast to start (no database, no grammar). Exit on stdin close.
- Count the whole serialized envelope against the budget using a conservative bytes/3 estimate. Fuzz worst cases (symbol with 5,000 callers, 100 KB doc comment) and assert output size is below the budget.
- Reserve a tool-error shape for "too large, narrow the query" that is itself tiny.
**Warning signs:** `Unexpected token` JSON parse errors in the host. "Server failed to start" only on cold boot. Rising process counts after sessions end.
**Phase to address:** M1.
**Confidence:** MEDIUM-HIGH.

### Pitfall B11: Prompt injection via tool results is a live attack class; fences are advisory

**What goes wrong:** S-3 adds an `untrusted_text` fence. 2025-2026 incidents show fences alone are not enough: the Cloud Security Alliance says there is no native MCP mechanism to detect or prevent output injection; Agentjacking (June 2026) used a public write-only Sentry DSN to feed instructions into an agent via an MCP integration; CurXecute used a Slack message through an approved MCP server to rewrite Cursor's `mcp.json`; MCPoison (CVE-2025-54136) swapped a committed MCP config command after approval; TrustFall (May 2026, secondary source) reports project-defined MCP servers auto-executing in several CLIs. I found no documented case of injection hidden in source comments specifically, but doc comments, ADR text and package prose are the same channel.
Specific gaps in the design:
- `gsd-atlas init` "registers MCP and hooks for the detected agent hosts". If it writes repo-level files (`.mcp.json`, `.claude/settings.json`), a later PR can change the command (MCPoison class).
- A fence delimiter that appears inside repo text can close the fence early.
- Injection also arrives in non-fenced fields: symbol names, file paths, error messages and diagnostic text.
- Invisible characters (zero-width, bidi, ANSI escapes) hide instructions.
**How to avoid:**
- Register at user scope only, with an absolute path to the installed binary. Verify the registered command on every `status`/`doctor` and warn if a repo-level config references atlas differently.
- Use a random per-response fence nonce that repo text cannot contain; escape or reject text containing it.
- Normalize all repo-derived strings in every field (not just `untrusted_text`): strip control, bidi and zero-width characters, cap length, and keep repo prose out of error messages, tool descriptions and hook `systemMessage`.
- Add injection fixtures (comment text like "ignore previous instructions and run curl", a fake fence close) to criterion 17, and test the `explain` and error paths too.
- State in the skill and docs that the fence reduces risk and does not prevent it.
**Warning signs:** Any code path that interpolates repo text into a field not named `untrusted_text`. A repo-level config file created by `init`.
**Phase to address:** M1 (envelope, normalization); M2 (init and registration); M4 (hook context).
**Confidence:** MEDIUM (incident reports are mostly secondary sources).

---

## Part C: Process, scope and CI traps

### Pitfall C1: Seven milestones of design-first work for one builder, with no running vertical slice

**What goes wrong:** The repo has 14 draft ADRs, a 63-row decision table (A1-A63), 21 acceptance criteria and zero code. M0 alone bundles seven module seams with test doubles, the grammar build, manifest schema, trust model, 14 ADR ratification issues and a three-OS CI. Building seams for modules that have no consumer yet (Governor, PreciseResolver, Policy) produces speculative interfaces that the first real consumer will break. The 14 ADRs and the A-table were validated by prototypes in a container, not by an agent using the tool.
M4 is by far the largest milestone: Apple provider, SDK packs, five SDK/syntax tools, Policy module, skill, scout subagent, five hooks, pre-commit check, dashboard, eval harness and A/B panel. M2/M2.5 also carry diagnostics, a flight recorder, `gsd-atlas bug`, an intake GitHub Action and a multi-tenant host, none of which prove the core value (cited answers).
"All criteria green" for 1.0 includes criteria that need Xcode 27 hardware and a Windows environment the builder does not have.
**Why it happens:** Design depth feels like progress. A solo builder with agents can generate code faster than they can verify design assumptions.
**How to avoid:**
- Insert a thin vertical slice before ratifying all 14 ADRs: gsd-core `.cts` into tree-sitter into SQLite into one MCP stdio tool (`code_find`) into 10 hand-written questions run against an agent. Time-box to roughly 2 weeks. Keep what survives; amend the ADRs that did not.
- Ratify ADRs lazily, each at the start of the phase that depends on it, not all in Phase 1. Cut "one GitHub issue per ADR" to an index file until phases need them.
- Defer M2.5 plus diagnostics intake, `bug`, flight recorder and the dashboard until after a public 0.x with real users exists, unless the milestone prerequisites say otherwise.
- Split M4 into three phases: SDK facts (Apple provider and packs), agent integration (skill, scout, hooks advise-only), enforcement and dashboard. Enforcement ships only if A/B data says it helps.
- Define 1.0 as a subset: criteria 1, 2, 4, 7, 10, 12, 17, 19 on gsd-core plus the eval. Hardware-gated criteria (6, 15) are a separate "platform-currency" release.
- Make the free-alternatives scan a 1-2 day task before M0/M1 starts, not before the M2 eval. If an LSP/SCIP-based MCP server covers 70% of `code_find`/`code_refs` (P-1), M1's scope changes. PROJECT.md currently says it should not gate build start; a time-boxed scan costs less than one wrong milestone.
**Warning signs:** M0 at week 6 with no end-to-end demo. Interfaces with no second implementation. ADR amendments after every spike.
**Phase to address:** Roadmap structure (now); M0.

### Pitfall C2: Rolling-target dependencies each impose a maintenance tax

**What goes wrong:** Atlas sits on seven moving surfaces: `node:sqlite` (Node minors), web-tree-sitter ABI, TypeScript 6/7.1, the MCP spec (2025-11-25 vs 2026-07-28) and SDK, Claude Code hook and MCP-client behavior, Xcode betas/`symbolgraph-extract`, and the user's `@types/node`. Each can break the product between releases with no code change of yours. A solo builder will lose weeks to "it worked on Friday".
**How to avoid:**
- Keep a volatility register in the repo (dependency, pinned version, canary, owner). Add one nightly CI canary per surface against `latest`/`next` (Node, TypeScript, web-tree-sitter, MCP SDK, Claude Code). Its failure opens an issue, not a red PR.
- Isolate each behind a seam you already own (Fact Store driver, Grammar Engine, PreciseResolver, Query adapters, hook adapters) and keep the contract tests as the only code that talks to the real thing.
- Do not support more host versions than you test.
**Phase to address:** M0 (register, canaries); each milestone adds its surface.

### Pitfall C3: Performance budgets in hosted CI are noise on Windows and macOS

**What goes wrong:** Budgets are "release gates" at p99 and wall-clock, on three OSes, from M1. The runner-images tracker has a long-running thread about slow and inconsistent Windows runners (#7320), a report of an image update making macOS-14 Xcode tests much slower (#11845), 8-core Windows runners only about 2x faster than 2-core, and macOS capacity varying. I found no published variance statistics for hosted runners. The 1,000-agent test and 500-worktree test run on shared 2-4 core machines with the load generator on the same CPU, which also under-reports tail latency (coordinated omission). Windows minutes bill at 2x and macOS at 10x for private repos.
**Consequences:** Either flaky red builds that teach the builder to ignore CI, or budgets inflated until they mean nothing.
**How to avoid:**
- Two classes of check. PR gates use deterministic, count-based or relative assertions: rows read, bytes read, parse count, git processes spawned, allocations, and time as a ratio to a calibration microbenchmark run on the same runner in the same job. Wall-clock p99 budgets run in a nightly job with 5+ repetitions, take the median and compare to a trailing baseline with a tolerance.
- Run the load generator in a separate process and use an open-loop arrival rate for latency. Keep 1,000-agent and 500-worktree scale tests nightly and on dedicated or self-hosted hardware if the hosted result is unreliable.
- Store results in a time series (a JSON file in a branch is enough), alert on drift over several runs, and record the runner image version with every result.
- Never put macOS-arm64-only or Xcode-27-only checks in required status checks.
- Write a flake policy: a perf check that fails once in 20 runs without a code change is demoted.
**Warning signs:** Re-run-until-green. Budget numbers that only pass on Linux.
**Phase to address:** M0/M1 (CI design before any budget is written down); M6 (performance pass).
**Confidence:** MEDIUM (issue trackers); variance data is a gap.

### Pitfall C4: The "≥ 80% with 50 questions" threshold is statistically unreachable as written, and run-to-run noise is larger than the effects you want to detect

**What goes wrong:** With 50 questions, a measured 80% has a 95% Wilson interval of about 67% to 89%. To show that the lower bound is ≥ 80% you need roughly 46 of 50 correct (92%). The PRD wants both "≥ 80%" and "beats grep outside the run-to-run interval". Recent work on 60,000 SWE-bench-Verified trajectories found single-run pass@1 moves by 2.2 to 6.0 points depending on which run you pick, even at temperature 0, and that claimed 2-3 point gains may be noise. Questions about one codebase are correlated, so the effective N is lower than 50. Three runs on one question set capture model variance, not question-set variance.
**How to avoid:**
- Use a paired design: the same questions, the same seeds where possible, both arms. Analyze with a cluster bootstrap that resamples questions and keeps all k runs per question (a published recipe: resample inputs with replacement, keep each input's k runs). Report the interval on the paired difference, not two separate intervals.
- Pool across corpora for the headline (4 corpora x 50 = 200 questions gives about ±5.5 points at 80%), and state per-corpus numbers as exploratory.
- Make the claim non-inferiority with a pre-registered margin (for example, atlas ≥ grep − 5 points) plus a token/tool-call reduction claim measured over all runs. Decide the margin and the analysis before the first run and commit it.
- Grade answers deterministically (expected file:line set or symbol name), not with an LLM judge. Hold out 20-30% of questions that are never used for tuning ranking, budgets or hook thresholds.
- Budget the cost: 4 corpora x 50 questions x 3 runs x 3-4 arms is 1,800-2,400 agent runs. Put a cost estimate in the roadmap.
**Warning signs:** A conclusion that flips between two identical runs. A threshold tuned after seeing results.
**Phase to address:** M2 (harness and pre-registration); M5 (four-corpus run).
**Confidence:** HIGH on the arithmetic; MEDIUM on the cited variance paper (arXiv 2602.07150, a preprint).

### Pitfall C5: Goodhart on the product's own metrics

**What goes wrong:** The dashboard's "context kept out", "problems caught" and "answers delivered" are self-reported and measure atlas's activity, not user outcome. Any hook rule tuned until the "problems caught" panel looks good will over-fire. Ranking tuned on the eval questions overfits. Eval questions authored by the person who knows what atlas indexes under-sample what it cannot answer (abstain cases are the PRD's guard, but they are written by the same hand). gsd-core is public, so a model may have partly memorized it; answers from memory inflate the grep arm and the atlas arm alike, and the benefit of atlas shrinks.
**How to avoid:** Keep the dashboard's honesty rules (PRD §8.4) and add one outcome metric nobody can move with atlas itself: eval pass rate on a held-out set at pinned SHAs. Write questions from real agent sessions on the corpus (user transcripts, issues), not from atlas's tool list. Include questions about code changed after the model's training cutoff (commits on `next` that are recent) to defeat memorization.
**Phase to address:** M2 (question authoring), M4 (dashboard).

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Run `typescript` (project's own) in the host process | Simplest adapter | Repo code runs unsandboxed; memory cannot be bounded; eviction does not free memory | Never past the M2 spike |
| In-memory-only ledger for gate counters | No new store | Block-loop after restart (B9) | Never for block caps; fine for advisory "seen" marks |
| Path as string key without a canonical function | Fast to write | Duplicate repos on Windows, case bugs on macOS, un-migratable store keys | Never. Do the path module in M0 |
| `git hash-object --path` per file | Matches git exactly | Thousands of processes; slow on Windows | Only in the M0 slice with fewer than 500 files |
| Rebuild `.wasm` grammars in every CI job | No artifact management | Cross-OS toolchain flakes; unreproducible parse rates | Never; cache by hash |
| Wall-clock p99 as a required PR check | Looks rigorous | Red/green noise, ignored CI | Never on hosted runners |
| Skipping `better-sqlite3` CI | Faster CI | Fallback rots; the stated mitigation for `node:sqlite` is then fictional | Never; run parity on every PR |
| Eval questions written after seeing atlas output | Easy to write | Invalid comparison | Never |
| Hardcoded Claude Code hook JSON shape | Works today | Breaks on host updates | Only with fixtures and a canary |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Claude Code MCP (HTTP) | Stateful sessions; no handling of host restart | Stateless server; stdio shim with host reconnect; restart test (A2) |
| Claude Code MCP output | Counting only result text against `budget_tokens` | Count the entire envelope; stay far under 25k tokens (B10) |
| Claude Code hooks | Trusting `stop_hook_active`; default timeout; PreToolUse output shape | Own persisted counters; explicit timeouts; fixture tests per version (B9) |
| `git` | Per-file spawn; background `git status` taking the index lock | Batch plumbing; `GIT_OPTIONAL_LOCKS=0` and `-z` everywhere (B6) |
| TypeScript | `readConfigFile` only; in-process compiler; assuming 7.x has an API | `parseJsonConfigFileContent`; child process; 6.x only until 7.1 (A1, B7) |
| web-tree-sitter | Using the runtime and a grammar built with a newer CLI; forgetting `.delete()` | Pin CLI+runtime+grammar together; `withTree` wrapper (B1, B2) |
| `node:sqlite` | Main-thread queries; assuming parity with `better-sqlite3` | Worker read pool; parity suite; known-bad version check (B3) |
| Xcode / `swift symbolgraph-extract` | Assuming a fixed output per SDK version | Key by SDK build; invalidate on Xcode path change; extraction can take minutes per framework `[UNVERIFIED]` |
| SDK packs | Sharing packs publicly or in CI artifacts | Treat packs as private build artifacts; check Apple's license terms before any publishing or Linux-CI use of Apple-derived data `[UNVERIFIED legal]` |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Event-loop blocking by sync SQLite or WASM parse | p99 spikes, hook timeouts | Worker pools (B1, B3) | Around 50-100 concurrent agents |
| WAL growth from long read transactions | `-wal` larger than DB | Short read transactions, keyset paging, WAL gauge (B4) | Under sustained readers plus edits |
| Name-matched `INFERRED` fan-out for common names (`get`, `init`) | Huge `code_refs` pages, slow `code_impact` | Cap per-name fan-out, rank by proximity, never expand INFERRED (M-5) | Any large TS corpus |
| One compiler program per tsconfig in monorepos | RSS grows with package count | Child-process compilers, explicit program budget (B7) | gsd-pi (14 tsconfigs) |
| Git process spawn on Windows | Slow cold index | Batch plumbing (B6) | Windows with greater than 1,000 files |
| Event storm after `git checkout` | Missed updates, queue overflow | Overflow leads to a scoped Reconcile (B5) | Branch switch of greater than 1,000 files |
| Short names and FTS trigram | Empty results for 1-2 char symbols | Exact index for short names (B3) | Always |
| Load tests on shared runners | Flaky or flattering tails | Open-loop generator in a separate process, nightly, dedicated hardware (C3) | 1,000-agent and 500-worktree tests |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Sending the bearer token to a fixed loopback port without server proof | Token leak to any local listener | Challenge-response; prefer socket/pipe (B8) |
| Pipe or socket name without user identity | Cross-user connection or squatting | Name includes SID/uid and major version; first-instance semantics (B8) |
| `init` writes repo-level MCP/hook config | MCPoison-class command swap via PR | User-scope registration; verify on `doctor` (B11) |
| Fence delimiter predictable | Repo text breaks out of fence | Per-response nonce (B11) |
| Repo text in error messages, symbol names, `systemMessage` | Injection through unfenced fields | Normalize and cap every repo-derived field (B11) |
| Running git with repo-controlled `core.fsmonitor` or `core.hooksPath` | Command execution from a hostile repo directory | Override via `-c` on every git call (B6) |
| Loading the project's `typescript` in-process | Repo code runs in the host | Child process under CommandRunner, minimal env (B7) |
| Diagnostics or `bug` bundles containing paths in free-form error strings | Privacy leak despite "no paths" rule | Run every outbound string through the redactor; test with canary paths in error text |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Atlas silently down after a host restart | Agents quietly lose atlas | Shim reconnects; SessionStart brief states `degraded`; `doctor` command (A2) |
| Store silently moved to the cache because of a synced folder | User cannot find or delete it | One notice plus `status` shows the location |
| Gate blocks without saying how to bypass | Frustration, user disables atlas | Every deny names the one cheap call that clears it and the user override |
| `degraded` flag with no reason | Agents ignore it | Reason code (`compiler_version_mismatch`, `watch_overflow`, `partial_parse`) in the envelope |
| Setup that needs Xcode, Node and a registered hook before first value | Drop-off before value | A `gsd-atlas init` that works with grammar tier alone on a plain clone, no host setup |
| Dashboard figures that read as savings guarantees | Distrust | Keep range plus method labels (PRD §8.4) |

## "Looks Done But Isn't" Checklist

- [ ] **Grammar tier:** Often missing the error-damage metric. Verify bytes-in-ERROR per file, not only `hasError`, on all three corpora.
- [ ] **Watcher:** Often missing overflow handling. Verify the storm test (5,000 files, 200 atomic rewrites) ends consistent on each OS with the watcher artificially starved.
- [ ] **Store open:** Often missing the concurrent first-open case. Verify 8 processes opening a fresh DB at once on Windows CI.
- [ ] **WAL:** Often missing a checkpoint under reader load. Verify WAL size stays bounded with 100 readers plus continuous writes.
- [ ] **Freshness:** Often tested only on Linux. Verify a Windows and macOS save-to-fact measurement, including atomic-write editors.
- [ ] **Spans:** Often tested only on LF ASCII. Verify CRLF, BOM and non-ASCII fixtures round-trip to the right file:line on Windows.
- [ ] **Worktrees:** Often missing sparse and submodule entries. Verify `skip-worktree` and gitlink fixtures do not produce deletions or read errors.
- [ ] **MCP stdio:** Often missing stdout purity. Verify every stdout line parses as JSON-RPC under `--trace-warnings`, on all OSes.
- [ ] **MCP HTTP:** Often missing restart recovery. Verify the host restarts between two calls and the same client keeps working.
- [ ] **Hooks:** Often missing the loop test. Verify a host that always re-fires Stop does not block more than 3 times, across a host restart.
- [ ] **TS adapter:** Often missing the TS 7 project case. Verify a TS 7.x fixture degrades with a reason instead of crashing.
- [ ] **Injection:** Often missing non-prose fields. Verify injection fixtures in a symbol name, path, error message and ADR title.
- [ ] **Eval:** Often missing an independent oracle. Verify every cited line was checked by a script that does not import atlas.
- [ ] **Budgets:** Often missing runner image version. Verify each perf result records OS image, Node, and the calibration score.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Built a TS 7 adapter on a non-existent API (A1) | MEDIUM | Delete adapter, keep seam; ship 6.x plus bundled-6.x fallback; re-open at 7.1 |
| Sessionful HTTP design strands clients (A2) | MEDIUM | Make requests stateless; default to stdio shim; add reconnect tests |
| Store corrupted by a synced folder or container | LOW | Store is derived: delete, rebuild, move to cache dir, add the detection case |
| WASM leak found in production | LOW | Worker recycling by file count plus heap threshold (hotfix), then wrapper audit |
| Grammar ABI skew after a dependency bump | LOW-MEDIUM | Pin to the last good set; rebuild from the pinned CLI; add the load test |
| Hook loop burned a user's session | HIGH (trust) | Ship a kill switch in `gsd-atlas hooks off`, persistent counters, advisory-only until A/B evidence |
| Eval result invalidated by weak baseline or leakage | HIGH | Re-run; keep raw transcripts so the analysis is re-runnable without new agent spend |
| Overbuilt M0/M2.5 with no users | HIGH | Cut to the vertical slice; park hosts, diagnostics intake and dashboard behind a post-0.x line |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| A1 TS 7 has no API | Pre-M2 spike; M2 | 7.x fixture degrades with reason; no `unstable` import in shipped code |
| A2 MCP stateless / session loss | M1 shim, M2.5 transport | Restart-between-calls test on both spec revisions |
| A3 Eval direction, circular oracle | Pre-M1 scan; M2 harness | Independent oracle script; pre-registered analysis |
| B1 WASM leaks | M0 wrapper, M1 soak | Flat heap in 100x parse soak |
| B2 ABI skew, wrong error metric | M0 build; M1 metric | Load-all-grammars CI job; bytes-in-ERROR report |
| B3 `node:sqlite` blocking/bugs | M0 driver; M1 pool | Event-loop-lag gauge; NUL round-trip; short-name test |
| B4 WAL/Windows/containers | M0 open sequence; M1 | 8-process fresh-open test; WAL size gauge |
| B5 Watcher drops | M1 | Storm test per OS; overflow triggers Reconcile |
| B6 Git plumbing | M0 fixtures; M1 batching | Spawn-count gauge; sparse/submodule/CRLF fixtures |
| B7 TS memory and config | M2 | gsd-pi 14-tsconfig run; RSS drops after eviction |
| B8 Windows endpoint and paths | M0 path module; M2.5 | Four-spelling path test; token-proof handshake test |
| B9 Hook loops | M4 | Loop-injection test; cold-daemon latency |
| B10 stdio hygiene, output size | M1 | stdout purity test; envelope-size fuzz |
| B11 Injection | M1, M2, M4 | Injection fixtures across all fields |
| C1 Scope and slice | Roadmap; M0 | Demo at the end of week 2; M4 split |
| C2 Moving targets | M0 | Nightly canaries green and tracked |
| C3 CI budgets | M0/M1 | Two-class budget policy; flake rate below threshold |
| C4 Eval statistics | M2 | Pre-registration committed; paired bootstrap output |
| C5 Goodhart | M2, M4 | Held-out set; outcome metric separate from activity metrics |

## Sources

- Microsoft TypeScript devblog, "TypeScript 7.0" (2026-07-08) and RC post: no stable programmatic API in 7.0, new API expected in 7.1, `@typescript/typescript6` compat package, 6.0 deprecations become errors. (fetched; HIGH)
- InfoQ, TypeScript 7 released (2026-08): same points. (fetched; MEDIUM-HIGH)
- MCP 2026-07-28 revision coverage (Composio, Nango, BetterStack, AAIF, Hackernoon, wati.io): removes initialize and `Mcp-Session-Id`; `_meta` per request; `server/discover`. (search results; MEDIUM; verify against the spec)
- Claude Code issues #27142, #60949, #62008, #75976 (stale `Mcp-Session-Id`, no re-initialize); #55754 (Stop hook loop, ~50 minutes); #54360 (`stop_hook_active` false); #47721, #50269, #57102 (`git` index-lock contention and stale locks in worktrees). (search results; MEDIUM)
- Repomix v1.16.1 release notes (web-tree-sitter Tree leak fix); web-tree-sitter 0.25 TypeScript rewrite and ABI 15; 0.25.2 earlier-CLI WASM crash fix; tree-sitter runtime accepts older ABI, not newer. (search results; MEDIUM)
- SQLite forum (win32 `LockFileEx` non-blocking, short-timeout flakiness); SQLite `useovernet`/WAL docs (WAL cannot work across machines); project reports of WAL "disk I/O error" on SMB or synced folders. (search results; MEDIUM-HIGH)
- Compatibility note on `node:sqlite` TEXT truncation at NUL (Node 22.23.x, 24.15.0, 25.9.0, 26.0.0). (single secondary source; LOW-MEDIUM; verify in Node release notes)
- Microsoft docs and efsw issue #142 on `ReadDirectoryChangesW` silent overflow; Chokidar and Coder docs on inotify `ENOSPC`; chokidar README on raw `fs.watch` macOS issues. (MEDIUM-HIGH)
- git docs on `--no-optional-locks`/`GIT_OPTIONAL_LOCKS` and sparse checkout / skip-worktree. (MEDIUM-HIGH)
- Node `net` docs on pipes; Claude Code issue #23573 (Windows named pipe EADDRINUSE); Rollup plugin PRs on drive-letter case. (MEDIUM)
- Cloud Security Alliance research notes on MCP tool poisoning, Agentjacking (2026-06), CurXecute, MCPoison CVE-2025-54136, TrustFall. (MEDIUM; several secondary)
- Codebase-Memory (arXiv 2603.27277) results as summarized in search results; independent flags on naive-grep baselines; fff end-to-end timing. (LOW-MEDIUM; PDF body not parsed)
- "On Randomness in Agentic Evals" (arXiv 2602.07150) and Indeed's cluster-bootstrap write-up on LLM evaluation intervals. (MEDIUM)
- GitHub runner-images issues #7320, #11845; vendor and blog material on runner speed. (anecdotal; MEDIUM-LOW)
- Not verified (gaps): Defender/antivirus effects on watcher or SQLite; macOS TCC behavior for detached daemons; Unix-socket path length limits; Apple licensing of redistributed SDK data; a `typescript/unstable` entry point in 7.0; toolchain needed for `tree-sitter build --wasm` per CLI version.

---
*Pitfalls research for: local code-intelligence and platform-SDK-facts MCP server*
*Researched: 2026-10-15*
