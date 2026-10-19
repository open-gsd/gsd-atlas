# How to report a bug

This guide writes a bundle on this machine that describes one defect, without your source text, so that you can attach it to a bug report. gsd-atlas never uploads the bundle: you read it first, and you attach it to an issue yourself. Names and paths are hashed unless you choose otherwise. Run the commands from inside the repository; `gsd-atlas` below stands for `node /path/to/gsd-atlas/dist/bin/gsd-atlas.js`.

1. At a terminal, start the bundle:

   ```sh
   gsd-atlas bug
   ```

   It says that it makes a bundle on this machine, that nothing is sent anywhere and that every data type starts denied. It then asks `What happened? `, `What did you expect? ` and `Steps to reproduce? `. Your answers are always in the bundle, scrubbed of paths, links, e-mail addresses and secret shapes: a path you type becomes `[removed]`.

2. Decide, type by type, what else goes in. For each of five data types it shows what it contains, how it helps and what it cannot reveal, and asks `Include "<title>"? [y/N] `. `y` includes it and `n` leaves it out. The titles are `Problem statement`, `Versions and configuration`, `Store and host health`, `Flight recorder excerpt` and `Failing answer`. To name the answer that was wrong, start with `--answer <answer id>`; the `answer_id` is in the answer's JSON.

3. Read the preview. It prints the exact bytes that will be written to `bundle.json`, then asks `Write this bundle on this machine? [y/N] `. Answer `n` and nothing is written (`gsd-atlas: nothing was written`, exit 1).

4. After `y`, find the bundle. stderr prints `gsd-atlas: bundle written to <path>`. The folder is `gsd-atlas/bug-reports/<id>` under your cache folder (`XDG_CACHE_HOME`, otherwise `~/.cache`) and holds `bundle.json` and `preview.txt`, readable only by you.

5. Attach `bundle.json` to a new issue of the project yourself. The command prints one sentence that says so and that atlas uploads nothing.

To delete a bundle, delete its folder. No gsd-atlas command removes one: `gsd-atlas bug --clear` empties the flight recorder of the repository, which is the local record of recent events, and leaves bundles alone.

## If you run it without a terminal

Nothing is asked. A data type is in the bundle only when `--include` names it, and at least one of `--what`, `--expected` and `--steps` is required:

```sh
gsd-atlas bug --what "find returned the wrong file" --expected "the file that defines the function" --steps "ran find on the function name" --include problem,versions --feature code_find --rating down
```

Without text the command stops with `bug_needs_text` and exit 2. The data types you can name are `problem`, `versions`, `health`, `recorder` and `failing`. The exact text of the bundle is in `data.preview` of the envelope.

## If you want the names readable

The default mode is `hashed`: names and paths become tokens of the form `<h:xxxxxxxx>`, the same name having the same token inside one bundle and a different token in the next. `--mode redacted` leaves names and paths out. `--mode raw` puts real symbol names and file paths into the bundle and marks the preview `RAW MODE: names and paths are included as they are`; read that preview with care before you answer `y`. Without a terminal `--mode raw` needs `--confirm-raw`; without it the command stops with `raw_not_confirmed` and exit 2, and nothing is written:

```sh
gsd-atlas bug --what "find returned the wrong file" --mode raw --confirm-raw
```

## If you do not want to include the failing answer

Answer `n` to `Failing answer`, or leave `failing` out of `--include`. Source text is never in a bundle in any mode.

For every option, exit code and what each data type holds, see [the CLI reference](../reference/cli.md#gsd-atlas-bug). For why nothing is uploaded, see [About how atlas decides what to trust](../explanation/how-atlas-decides-what-to-trust.md#why-is-there-no-telemetry-and-why-are-diagnostics-off-by-default).
