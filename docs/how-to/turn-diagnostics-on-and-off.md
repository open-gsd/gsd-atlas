# How to turn diagnostics on and off

This guide turns diagnostics on for the data types you choose, shows you the report they would make, and turns them off again. Diagnostics are off by default, and nothing is collected until you approve a data type. A report is a text you read on this machine. Nothing is submitted in this release. Run the commands from inside the repository; `gsd-atlas` below stands for `node /path/to/gsd-atlas/dist/bin/gsd-atlas.js`.

1. At a terminal, walk through the data types:

   ```sh
   gsd-atlas diagnostics enable
   ```

   For each of the ten data types it shows the fields with the real values from this machine, how the type helps the project and what it cannot reveal, then asks:

   ```text
   Share "<title>" in reports? [a]pprove / [d]eny / ask [e]ach time (Enter = deny):
   ```

   `a` approves, `d` or Enter denies, `e` means ask each time. Every type starts denied. The `Report header` type is required: with it denied no report can be built. Your choices are saved in `diagnostics.json` in your user configuration folder, `~/.config/gsd-atlas` unless `GSD_ATLAS_USER_DIR` names another; a repository can never set them.

2. Read the report your choices would make:

   ```sh
   gsd-atlas diagnostics preview
   ```

   `data.body` is the report as text and `data.json` its fields. It holds only the approved types. While diagnostics are off, the result is `{ "enabled": false }` and the diagnostic `diagnostics_off`.

3. To keep a copy on this machine, add `--save`:

   ```sh
   gsd-atlas diagnostics preview --save
   ```

   stderr says where it went: a file named for the time, under `diagnostics/reports` in your state folder (`XDG_STATE_HOME`, otherwise `~/.local/state`), readable only by you.

4. List the saved reports:

   ```sh
   gsd-atlas diagnostics history
   ```

5. To turn everything off:

   ```sh
   gsd-atlas diagnostics disable
   ```

   It resets every choice to denied, removes the saved reports and the local diagnostics folder, and empties the flight recorder of this repository. It needs no terminal.

## If you want to change one type later

At a terminal, name it:

```sh
gsd-atlas diagnostics types notes
```

With no type name it walks all ten again. A type you leave unanswered keeps its current state.

## If a type asks for review

The catalog of data types changed since you approved one, so it is off until you look at it again. The command prints `The catalog changed these data types since you approved them, so they are off until you review them again:` followed by their ids. Run `gsd-atlas diagnostics types <id>` for each and answer again.

## If you want to add a note or a rating

Approve the `notes` or `ratings` type first. Then:

```sh
gsd-atlas diagnostics preview --note "find was slow" --rating down --feature code_find
```

Without the type the option is ignored and stderr says so, for example `--note ignored: the notes data type is not approved`. `--feature` takes a rating feature, `last` or `session`, and needs `--rating`.

## If a type is set to ask each time

At a terminal, `preview` asks `Include "<title>" in this report? [y/N] ` for it. Without a terminal it leaves the type out and names it on stderr.

## If you run it without a terminal

`enable` and `types` stop with `diagnostics_needs_terminal` and exit 2, and change nothing. `preview`, `history` and `disable` do not need one.

For the table of data types and the fields of each, see [the CLI reference](../reference/cli.md#gsd-atlas-diagnostics). For why diagnostics are off by default and why nothing is sent, see [About how atlas decides what to trust](../explanation/how-atlas-decides-what-to-trust.md#why-is-there-no-telemetry-and-why-are-diagnostics-off-by-default).
