# How to register the MCP server with Claude Code, Cursor and Codex

This guide registers the `gsd-atlas-mcp` server in the user-level configuration of the coding agents installed on your machine. It assumes a built clone: `npm run build` has run in it, with Node 24.16.0 or newer.

1. Preview what `init` would do:

   ```sh
   node dist/bin/gsd-atlas.js init --dry-run
   ```

   The output is one JSON envelope. Read `data.hosts`: each entry names an `agent`, the `file` it would change and the `action` it would take (`created`, `updated`, `unchanged`, `skipped` or `refused`). A dry run writes nothing.

2. Register the server:

   ```sh
   node dist/bin/gsd-atlas.js init
   ```

   To register with one agent only, name it; `--agent` is repeatable and takes `claude`, `cursor` or `codex`:

   ```sh
   node dist/bin/gsd-atlas.js init --agent cursor
   ```

   Each host is edited in its own file:

   | Agent | File | What `init` writes |
   | --- | --- | --- |
   | `claude` | `~/.claude.json` | `mcpServers["gsd-atlas"]`, only if the file already exists |
   | `cursor` | `~/.cursor/mcp.json` | `mcpServers["gsd-atlas"]`, creating the file if the `~/.cursor` folder exists |
   | `codex` | `~/.codex/config.toml` | the table `[mcp_servers.gsd-atlas]`, creating the file if the `~/.codex` folder exists |

   The entry runs the Node executable that ran `init`, with the absolute path of `dist/bin/gsd-atlas-mcp.js` in your clone as its argument. When `init` changes an existing file for the first time, it keeps the original beside it as `<file>.gsd-atlas-backup`.

3. Build the repository you want to ask about, before the agent starts. After a registration that is not a dry run, `init` prints a hint like this on stderr when it finds a git repository above the working directory that has no index:

   ```
   gsd-atlas: to index /path/to/atlas-demo, run `gsd-atlas build` inside it
   ```

   In that repository, run:

   ```sh
   node /path/to/gsd-atlas/dist/bin/gsd-atlas.js build
   ```

   Only `build` creates an index, and it cannot run while an agent's server is already holding the writer lease for the repository; see [why](../explanation/how-freshness-and-the-writer-lease-work.md).

4. Check that the registration took. Run `init` again: every host you registered with now reports `unchanged`.

## If a host is skipped

- `not_detected`: neither the config file nor the agent's folder (`~/.claude`, `~/.cursor` or `~/.codex`) exists under your home directory. Nothing was changed; `init` registers only with agents it finds. When no host is found at all, stderr says `gsd-atlas: init: no agent host was found under <home>`.
- `config_not_found`: the `~/.claude` folder exists but `~/.claude.json` does not, and Claude Code creates that file itself. `init` prints a command to register by hand on stderr:

  ```
  claude mcp add --scope user gsd-atlas -- /path/to/node /path/to/gsd-atlas/dist/bin/gsd-atlas-mcp.js
  ```

## If a host is refused

`init` leaves the file untouched, reports `refused` with a reason, and exits 2.

- The file is not valid JSON, its top level is not an object, or `mcpServers` is not an object: fix the file by hand, then run `init` again.
- The Codex file has a `gsd-atlas` table that `init` cannot edit safely as text (the reason names the line): edit that table by hand.
- `config_in_use`: the operating system refused to replace the file, because another program holds it open or its folder is not writable. Close the program or fix the folder permissions, then run `init` again. Nothing was changed.
- `config_changed_during_init`: the file changed while `init` was running. Nothing was written; run `init` again.

## If the clone moved or Node changed

The entry holds absolute paths. Run `init` again from the new location, or with the new Node: it reports `updated` and rewrites the entry.

For every option and the `init` envelope, see [the CLI reference](../reference/cli.md). For the tools the server offers, see [the MCP reference](../reference/mcp.md).
