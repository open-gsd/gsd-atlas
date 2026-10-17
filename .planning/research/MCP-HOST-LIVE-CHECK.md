# MCP host live check (Codex CLI, Cursor CLI)

Date: 2026-10-17. No login, no model prompt, no credentials. All runs used a scratch HOME
(`<scratch>/host-test/home`, CODEX_HOME=`home/.codex`, XDG_* in `home/`); the real home was untouched.
Scratch: /private/tmp/claude-501/-Users-trekkie-projects-gsd-atlas/574e2e7c-90ac-4735-937f-89838839355a/scratchpad/host-test

## Verdicts
- OpenAI Codex CLI (codex-cli 0.163.0): ACCEPTED (config parsed, server listed with right command/args; existing content preserved). Starting the server from Codex without a model was not possible (no such subcommand); the server was started by hand with the same command/args and answered initialize + tools/list.
- Cursor CLI (cursor-agent 2026.10.16-e3cb207): ACCEPTED, and stronger: `agent mcp list` reported `gsd-atlas: ready` and `agent mcp list-tools gsd-atlas` returned the 6 tools, so Cursor actually launched the server.

## Codex
1. `npm install --prefix <scratch>/codex @openai/codex` then `codex --version` -> `codex-cli 0.163.0`.
2. Pre-seeded `home/.codex/config.toml`: header comment, `model = "gpt-x"`, `[mcp_servers.other]`, trailing comment.
3. `gsd-atlas init --agent codex --dry-run` -> action `created` (nothing written); real run -> action `updated`.
   Diff vs before: pure append, original bytes unchanged, a `.gsd-atlas-backup` was written beside it:
```
[mcp_servers.gsd-atlas]
command = "/opt/homebrew/Cellar/node/26.11.1/bin/node"
args = ["/Users/trekkie/projects/gsd-atlas/src/bin/gsd-atlas-mcp.ts"]
```
4. `codex mcp list` (rc 0, no parse error): gsd-atlas and other both listed, enabled, Auth "Unsupported" (normal for stdio).
   `codex mcp get gsd-atlas`: transport stdio, command and args as above, enabled true. `codex mcp list --json` confirms the same.
5. Not checkable: Codex has no model-free server start/probe. Manual stdio run of the same command/args returned
   protocolVersion 2025-06-18, serverInfo gsd-atlas 0.0.0 and the tools list.

## Cursor
1. `curl https://cursor.com/install` installer (only writes under $HOME and ~/.local) run with scratch HOME; installed `cursor-agent`/`agent` 2026.10.16-e3cb207. No login needed for `--version` or `mcp` subcommands.
2. `gsd-atlas init --agent cursor` with no `~/.cursor` -> `skipped / not_detected`, exit message "no agent host was found" (by design; note for docs: init only writes hosts it detects).
3. After `mkdir ~/.cursor` with an existing `mcp.json` containing `other`: action `updated`; `other` preserved, added
   `"gsd-atlas": {"type":"stdio","command":"<node>","args":["<repo>/src/bin/gsd-atlas-mcp.ts"]}`.
4. `agent mcp list` -> `other: Error: Connection failed` (fake server, expected), `gsd-atlas: ready`.
   `agent mcp list-tools gsd-atlas` -> 6 tools: atlas_status, code_context, code_find, code_impact, code_refs, lang_list.

## Caveats
- Paths written are absolute to the dev checkout's `.ts` entry and the Homebrew node binary (fine for a dev run; a published install will differ).
- Single machine (macOS arm64); Windows/Linux not exercised. Codex rewrite of config.toml by init was append-only; tables-before-comments layout (new table placed after the trailing comment) is valid TOML.
