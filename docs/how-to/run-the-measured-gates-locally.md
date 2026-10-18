# How to run the measured gates locally

This guide runs the four gates that measure recall, the corpus build, the store size and the save-to-find time, and reads their results. It assumes a built clone (`npm ci --ignore-scripts` and `npm run build` have run) and git on the path.

The two corpus gates (`recall:corpus` and `gates:corpus`) fetch a pinned checkout of the repository named in `corpora/corpora.json` into a new temporary directory, over the network, and remove it when they end. They need git access to that repository. `size-gate` and `gates:freshness` need no network.

1. Measure recall against the TypeScript compiler:

   ```sh
   npm run recall:corpus
   ```

   The gate fetches the pinned corpus, takes a fixed sample of its files (every `.cts` under `src/` plus 300 `.cjs` files, chosen by a hash of their path), and prints one table per language module (`typescript`, then `javascript`): a row per construct with `truth`, `found`, `matched`, `recall` and `status`. Recall is never pooled across constructs. A construct the corpus has none of shows `n/a`.

   ```
   module typescript (corpus: 274 files of gsd-core at 10ac3a7a9479), minimum 90.0%
   construct            truth   found  matched   recall  status
   function              3435    3435     3435   100.0%  ok
   enum                     0       0        0      n/a  n/a
   ```

   The gate passes, with exit 0, when every applicable construct is at or above the minimum (default 90%, set with `--min`, a number from 0 to 1) and something was measured. A construct below the minimum shows `fail` and the exit code is 1. A file that cannot be measured is listed as `FAILED <file>: <reason>` (the first 10, then a count) and does not by itself fail the run. Options: `--module` (repeatable: `typescript`, `javascript`), `--min`, `--sample-size` (default 300). Pass them after `--`.

2. Build the corpus twice and check the result:

   ```sh
   npm run gates:corpus
   ```

   The gate builds the pinned corpus through the same Host the bins use, builds it a second time, and checks the result against what it works out for itself from git. It prints the two builds, the file accounting, the parse-error rate per module and the database size, then one line per check:

   ```
   first build: files 1689 parsed 1686 linked 3 removed 0 skipped 1 failed 0 elapsed 5694 ms
   second build: files 1689 parsed 0 linked 1689 removed 0 skipped 1 failed 0 elapsed 642 ms
   corpus-gates: module typescript: 283 files, 0 with parse errors (0.00%)
   PASS second build parses zero files: parsed 0, linked 1689 of 1689 files (first build: 1689)
   PASS database size: 37740544 bytes, limit 52428800
   corpus-gates: OK
   ```

   The `elapsed` times differ on every run and are not judged. The checks are:
   - every indexed path is in git's file list;
   - the indexed set equals an independently audited source set;
   - the accounting identity: indexed, skipped, too large and unclaimed files add up to the files git lists;
   - the second build parses zero files and links every one;
   - per module, at most 0.5% of the files have parse errors;
   - the database is at most 52428800 bytes (50 MiB).

   Any `FAIL` line makes the last line `corpus-gates: FAILED` and the exit code 1.

3. Check that the store stays small under editing:

   ```sh
   npm run size-gate
   ```

   The gate builds a store of synthetic files (default 300), applies many edits (default 20000), runs the store's idle maintenance every 200 edits, and compares the edited store with a fresh build of the same content. It prints one line:

   ```
   size-gate: files 50 symbols 8 edits 500 maintain-every 200 freshBytes 208896 idleBytes 204800 idleRatio 0.9804 max 1.25 settledBytes 204800 settledRatio 0.9804 vacuums 3 longestMaintainMs 10.4 dbstat present maintainRuns 3 seconds 0.2 OK
   ```

   The asserted figure is `idleRatio`, the size after idle maintenance alone divided by the size of the fresh build. The line ends `OK` and the exit code is 0 when it is at most `max` (default 1.25), and `OVER` with exit 1 otherwise. `settledRatio` is the size after an explicit full compaction and is printed for information only. `longestMaintainMs` is reported, not asserted. For a quick local sample, reduce the run: `npm run size-gate -- --files 50 --edits 500`. Options: `--files`, `--edits`, `--symbols` (default 8), `--max-ratio`, `--maintain-every` (default 200; 0 turns maintenance off), `--driver` (`node:sqlite` or `better-sqlite3`).

4. Measure save to find:

   ```sh
   npm run gates:freshness -- --saves 30 --max-ms 3000
   ```

   The gate builds a synthetic repository (default 200 files) through the composed Host, then saves files one after another, alternating an edit of an existing file with a new file. For each save it times how long the next `code_find`, asked without `fresh`, takes to return the new definition. It prints one line:

   ```
   freshness-gate: saves 30 files 200 watch native p50 217 ms p95 226 ms p99 237 ms max 3000 ms (nearest rank) OK
   ```

   Percentiles use the nearest-rank method, so the p99 of fewer than 100 saves is the largest value. The line ends `OK` and the exit code is 0 when p99 is at most `--max-ms`, and `OVER` with exit 1 (and a second line naming the figures) otherwise. The defaults are 30 saves and `--max-ms` 1000. Options: `--saves`, `--max-ms`, `--files`.

## If a corpus fetch fails

The gate prints `recall: ...` or `corpus-gates: ...` with a code and the failing git step, and exits 1. The codes are `fetch_failed` (git could not fetch the pinned commit from the repository), `manifest_invalid`, `unknown_corpus`, `corpus_not_pinned` and `destination_inside_repo`. For `fetch_failed`, check that git can reach the repository named in `corpora/corpora.json`. The gates leave nothing behind.

## If a gate fails

- `recall:corpus`: the table rows with `fail` name the constructs below the minimum.
- `gates:corpus`: the `FAIL` lines name the failing check and give the figures behind it.
- `size-gate`: the `idleRatio` is above `max`.
- `gates:freshness`: `p99` is above `--max-ms`. `watch` shows how file events arrived (`native`, `poll` or `reconcile-only`).

## If you want to keep the corpus checkout

Run `npm run gates:corpus -- --keep`. The temporary directory it created, named `gsd-atlas-corpus-gates-` followed by random characters, stays in the operating system's temporary directory; the script does not print its path. Remove it yourself when you are done.

## If you need the strict freshness figure

The pull request job passes `--saves 30 --max-ms 3000`, the looser ceiling, because hosted runners are noisy (`.github/workflows/ci.yml`). The nightly job passes `--saves 100 --max-ms 1000`, the strict one-second p99 over 100 saves, and runs `gates:corpus` with its timings printed (`.github/workflows/nightly.yml`). To judge the strict figure locally, run `npm run gates:freshness -- --saves 100 --max-ms 1000`.

For the CLI commands the gates exercise, see [the CLI reference](../reference/cli.md).
