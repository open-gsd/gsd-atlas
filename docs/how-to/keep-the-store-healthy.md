# How to keep the store healthy

This guide checks the index of a repository you have built, and tidies it. Run the commands from inside the repository; `gsd-atlas` below stands for `node /path/to/gsd-atlas/dist/bin/gsd-atlas.js`.

1. Check the index:

   ```sh
   gsd-atlas health
   ```

   Read `data.health`, which is `ok` or `degraded`. When it is `degraded`, `data.reasons` says why. `data.store.sizeBytes` is the size of the store file.

   | Reason | What it means and what to do |
   | --- | --- |
   | `follower` | This process does not hold the writer lease, so it answers read-only. That is expected while another process, such as an agent's server, holds it. Index and maintenance commands need the lease; see [If `maintain` returns `lease_held`](#if-maintain-returns-lease_held). |
   | `rebuilding` | A corrupt store was found, moved aside and rebuilt (`data.store.rebuilt` is `true`). Answers are served while it settles; ask again afterwards. |
   | `reconciling` | The index is catching up with the working tree after start-up. Ask again in a moment. |
   | `stale_files` | A worktree has paths the index has not caught up with yet. Run `gsd-atlas maintain reconcile`, or name the changed paths with `--fresh` when you ask. |
   | `watch_fallback` | File events are not arriving (`data.indexer.watchMode` is `reconcile-only`), so the index is brought up to date by periodic reconciles. After editing, run `gsd-atlas maintain reconcile`, or name the changed paths with `--fresh`. |
   | `indexer_failures` | The indexer gave up on one or more paths. `data.indexer.failed` is their count; the paths are not listed. |

2. See what the index has been used for:

   ```sh
   gsd-atlas status
   gsd-atlas status --since 24h
   ```

   `status` covers the last 7 days unless `--since` gives another window (`30m`, `12h`, `7d`). Its token figures are estimates.

3. Run the upkeep tasks. With no task, `maintain` runs all of them:

   ```sh
   gsd-atlas maintain
   ```

   To run one task, name it: `reconcile`, `resolve`, `refresh`, `collect`, `compact` or `check`. Each reports whether it `complete`d, the time it spent, and what it processed; `check` also reports `ok`.

4. Reclaim space after heavy editing:

   ```sh
   gsd-atlas maintain compact --full
   ```

   A full compaction cannot be interrupted once it has started. A running server compacts by itself after a quiet period, so an explicit full compaction is rarely needed (see [why compaction waits for idle](../explanation/how-freshness-and-the-writer-lease-work.md#why-does-compaction-wait-for-idle)).

## If `maintain` returns `lease_held`

Another process holds the writer lease for the repository, usually an agent's server. The answer names its process id, and the command ends with exit 3. Every task except `resolve` needs the lease, and there is no way to hand the task to the process that holds it. End that session, run `gsd-atlas maintain` again, then start the agent again. See [the writer lease](../explanation/how-freshness-and-the-writer-lease-work.md#what-is-the-writer-lease-and-why-do-followers-exist) for why.

## If `maintain` returns `not_indexed`

The repository, or this worktree, has not been built. Run `gsd-atlas build`, then `maintain` again.

## If `--full` is refused

`--full` applies only to `maintain compact` and `maintain all`. Any other task gives a usage error and exit 1.

## If the index was built by an earlier development build

Questions about the repository answer `not_indexed`, with the text `This repository has not been indexed yet. Run "gsd-atlas build" in a terminal inside it, then ask again.` The index (`facts.db`) is derived data, so this build deletes the old one when it opens it and creates a new one. Run `gsd-atlas build` once. It prints its usual result, with every file counted under `parsed`, and the repository is indexed again. Only the index is rebuilt from the repository; your files are not touched. See [the MCP reference](../reference/mcp.md#atlas_status), row `store`, for the schema version.

## If the index was written by a newer gsd-atlas

The answer is `schema_too_new`, and its text says to upgrade gsd-atlas, or remove the index.

For every option, exit code and result field, see [the CLI reference](../reference/cli.md). For the `health` fields, see [the MCP reference](../reference/mcp.md).
