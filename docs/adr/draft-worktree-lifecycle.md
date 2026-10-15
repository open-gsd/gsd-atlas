# ADR: Worktree overlays, retirement and history from git

- **Status:** Proposed
- **Issue:** to be opened (rename to `<issue#>-worktree-lifecycle.md`)
- **DESIGN.md:** A5, A20, A21, A43
- **Review findings addressed:** F‑1 (overlay side), L‑1, L‑2, L‑3, H‑6

## Context
Agents work across many branches and short‑lived worktrees. The store must reflect each one's current state, never accumulate old versions, repair itself when events are missed, and still answer "what did this look like at commit X". The design review found a logic bug in the earlier collection rule (uncommitted content was never collected) and an overstated claim that new worktrees are fully live instantly.

## Decision
1. **Overlays:** each worktree or branch is an overlay mapping paths to content hashes (git blob ids, fact‑model ADR).
   - **Local facts** are shared by hash, so a new worktree at an indexed commit has them immediately from `git ls-tree`; only dirty files are parsed.
   - **Resolved edges** come from the cache when another overlay has the same snapshot and resolution context; otherwise they are computed lazily on first query.
2. **Lifecycle:** indexed → live (some overlay points at the hash) → retired (none does) → collected.
   - **Collection rule:** a retired version is collected when **either** its content exists as a git object (git can rebuild it) **or** the grace period has expired (default 24 hours, `lifecycle.grace`).
   - Switching back within grace revives a version without re‑parsing.
   - Resolved‑edge caches for a dropped overlay snapshot are discarded immediately.
3. **History comes from git, not the store.** `history --at <commit>` indexes the requested files' local facts from local git objects into a temporary in‑memory store and discards it (1‑hour cache). Resolved edges at a past commit need the whole project at that commit, so they're computed only with `--precise`, with the cost stated. Missing commits in shallow clones are fetched only when `history.allow_fetch` is on in user config.
4. **Submodules** of a repo join its workspace automatically, so the parent's agents can see code they import from a submodule.
5. **Self‑maintenance** runs in idle time (200 ms slices, backing off under load):
   - **Reconcile:** every 5 min and on git events, against `git ls-files -s` plus untracked, non‑ignored files.
   - **Resolve:** dangling references.
   - **Refresh stale:** after module, grammar, compiler or SDK changes.
   - **Collect:** every 15 min.
   - **Compact:** `incremental_vacuum`, `optimize`, WAL checkpoint; full `VACUUM` when free pages exceed 25 %.
   - **Check:** `quick_check`.

   Each is also a CLI command and reported in `status`.
6. **File watching:** watch tracked directories only. When the OS runs out of watches (e.g. Linux inotify limits), fall back to Reconcile polling and say so in `status`.

## Evidence (2026‑10‑15)
20,000 edits to a 10,000‑file store (fresh 69 MB):
- keep old versions: 212 MB;
- collect: 90 MB;
- collect plus compact: 80 MB, longest maintenance pause 65 ms.

## Consequences
- The store stays near the size of a fresh build no matter how much churn, including uncommitted churn.
- New worktrees answer local questions immediately; their first resolved query may wait for lazy resolution.
- Missed file events are repaired within one Reconcile interval.
- History queries are cheap for local facts and explicitly costly for resolved edges.

## Alternatives considered
- **Keep versions for history:** store grows with every save (3× in the test).
- **Collect only when both git‑backed and past grace (earlier draft):** uncommitted content never collected.
- **Delete immediately on change:** loses "what did the agent change this session" for uncommitted edits.
- **Full copy per worktree:** multiplies storage by worktree count.
