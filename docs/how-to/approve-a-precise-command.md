# How to approve a precise command for one repository

This guide lets gsd-atlas run the precise command that a language module declares, for one repository. Only a person at a terminal can do it. It assumes a built index and a language module whose manifest has a `precise.command`; none of the built-in modules declares one. Run the commands from inside the repository; `gsd-atlas` below stands for `node /path/to/gsd-atlas/dist/bin/gsd-atlas.js`.

What is never possible, whatever you do:

- A repository cannot enable a command. Nothing in it, not a manifest, not a config file, approves anything; the only source of permission is your own user-level configuration.
- The MCP server never runs an approved command unless a person started it with `--allow-build`.
- An approval is for one repository and one exact command: the executable, its arguments and its working directory. A change to any of them no longer matches.

The reasons for these rules are in [About how atlas decides what to trust](../explanation/how-atlas-decides-what-to-trust.md).

1. See the state of the module's precise tier:

   ```sh
   gsd-atlas lang list
   ```

   Find the module in `data.modules` and its `precise` entry in `tiers`. A command that is not approved shows `"active": false` and the reason `command_not_approved`.

2. Start the approval for the command the module declares, or for a command you type after `--`:

   ```sh
   gsd-atlas allow --module <module name>
   ```

   ```sh
   gsd-atlas allow -- <executable> <arguments>
   ```

   The second form takes the working directory from `--workdir`, relative to the repository.

3. Read the review that appears before the question. It shows the repository, the executable, the arguments, the working directory relative to the repository and the approval hash. For a command that a module proposes it says so, and you should read it as carefully as if you had typed it. Nothing runs at this point. Answer `y` only if the review is exactly what you expect. Any other answer approves nothing and writes nothing.

4. Run the maintenance task that uses the command, and read how it went:

   ```sh
   gsd-atlas maintain resolve
   ```

   `data.tasks.resolve.precise.command` reports `ran`, `ok`, `exitCode`, `timedOut` and `needsApproval`. Only the exit status, the signal, the time-out flag and the duration are reported, never the command's output. `lang list` now shows the reason `command_approved`; the tier stays inactive, because an approved command is a gate and not an importer.

## If `allow` says it needs a terminal

`allow needs a terminal` and exit 2: standard input or the stream you read is not a terminal, so nothing was sent or written. Run the command in a terminal.

## If the command changes later

A changed argument, working directory or manifest no longer matches the approval. `lang list` shows `command_not_approved` again, and `maintain resolve` reports `needsApproval`. Run `gsd-atlas allow` again and read the new review.

## If you want an agent's MCP server to run it too

The approval is read when a server starts, so restart a running server. A server also needs a person to start it with `--allow-build`; without that flag it never runs the command, whatever you approved. Start the server yourself with the flag only for a repository and a command you trust. See [the MCP server flags](../reference/mcp.md#start-up-flags).

## If you want to revoke an approval

Remove its entry from `permissions.allow` in `config.json` of your user configuration folder, `~/.config/gsd-atlas` unless `GSD_ATLAS_USER_DIR` names another. Keep the file valid JSON: a file with a wrong key or value is ignored whole.

## If you want the built-in providers off

Add the provider's id to `providers.disabled` in the same file. The id `typescript` turns off the compiler tier and leaves the grammar tier:

<!-- verified-by: code: src/host/config.ts -->
```json
{ "providers": { "disabled": ["typescript"] } }
```

For every option and exit code of `allow`, see [the CLI reference](../reference/cli.md#gsd-atlas-allow). For the tier states, see [the TypeScript support reference](../reference/typescript-support.md#tiers).
