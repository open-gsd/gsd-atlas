# MCP host config formats: Cursor, Codex CLI, Claude Code (checked 2026-10-17)

Purpose: verify what `gsd-atlas init` writes (src/cli/init-targets.ts). Primary sources only. Anything not confirmed is marked UNCONFIRMED.

## Cursor
Source: https://cursor.com/docs/context/mcp
- Location: global `~/.cursor/mcp.json`; project `.cursor/mcp.json`. Windows path: UNCONFIRMED (page gives no Windows path; by convention `%USERPROFILE%\.cursor\mcp.json`).
- Top-level key `mcpServers`, object of name -> config.
- stdio keys: `command` (required; on PATH or full path), `args` (optional array), `env` (optional), `envFile` (optional, stdio only). `type` is listed as "stdio" in the field table, but the page's own stdio example omits it, so it is effectively optional (the page is internally inconsistent).
- Remote: `url`, `headers`, `auth` (CLIENT_ID required). `cwd`: not documented. Startup timeout / enabled flag: not documented.
- Interpolation in command/args/env/url/headers: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`.
- Unknown keys tolerated: UNCONFIRMED. Restart on edit: UNCONFIRMED (page only says toggle servers in Customize; restart Cursor after updating custom server files).
- Verdict: `{command,args}` under `mcpServers.gsd-atlas` matches the documented stdio example exactly.

## Codex CLI
Sources: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (308 redirect from developers.openai.com/codex/mcp); https://learn.chatgpt.com/docs/config-file/config-reference (from developers.openai.com/codex/config-reference); https://github.com/openai/codex/blob/main/docs/config.md (stub pointing to those); source https://raw.githubusercontent.com/openai/codex/main/codex-rs/config/src/mcp_types.rs
- Location: user `~/.codex/config.toml` (`$CODEX_HOME` implied default `~/.codex`); project `.codex/config.toml`, trusted projects only. Windows path: UNCONFIRMED (docs give none; `%USERPROFILE%\.codex\config.toml` by convention). CODEX_HOME override not defined on the reference page.
- Table: `[mcp_servers.<id>]`. Keys, stdio: `command` (required), `args`, `env` (map), `env_vars`, `cwd`, `experimental_environment`. Common: `startup_timeout_sec` (default 10), `startup_timeout_ms` (alias), `tool_timeout_sec` (default 60), `enabled`, `required`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode`, `tools.<tool>.*`. HTTP: `url` (required), `bearer_token_env_var`, `http_headers`, etc. No `type`/transport key; transport is inferred from `command` vs `url`.
- Server id rules: the docs state none. The Rust commit "Added mcp-server name validation (#1591)" and the Codex MCP docs say ids must match `^[a-zA-Z0-9_-]+$` (search-result summary of https://forge.lthn.ai/core/core-agent-ide/commit/0bc7ee91937d5cb9ff0e6a77e35cc89a91a81892, a mirror; not directly fetched, so mirror-level confidence). `gsd-atlas` passes. TOML bare keys allow `A-Za-z0-9_-` (TOML spec, https://toml.io/en/v1.0.0#keys), so no quoting is needed for `gsd-atlas`.
- Unknown keys: `RawMcpServerConfig` has no serde `deny_unknown_fields` (schemars only), so unknown top-level keys in a server table are ignored; the flattened transport enum rejects unknown keys (`deny_unknown_fields`) and `throw_if_set` rejects fields not valid for the chosen transport (e.g. `url` plus `command`). Per-source summary; verify against mcp_types.rs if it matters.
- Restart: docs mention Restart only for desktop app/IDE extension; CLI: not documented (UNCONFIRMED; a new `codex` session reads config at start).
- Verdict: `[mcp_servers.gsd-atlas]` + `command` + `args` matches.

## Claude Code
Source: https://code.claude.com/docs/en/mcp (first 100k of 123k chars read)
- User scope stored in `~/.claude.json`; top-level `mcpServers` for user scope is implied ("top level of ~/.claude.json (user scope)"); the explicit example shown is local scope nested under `projects`. Project scope: `.mcp.json` with `mcpServers`.
- stdio entry: `{type:"stdio", command, args, env}`. `type` is not required: an entry with no `type` is read as stdio (and `url` without `type` is an error). Windows `cmd /c` guidance: not on the page. Restart: no general requirement stated.
- Verdict: `{type:'stdio',command,args}` valid.

## Comparison with init-targets.ts
- Claude entry, src/cli/init-targets.ts:135: matches. Not a mismatch: file at :131 is `~/.claude.json`, and createsFile false (:134) is consistent with Claude owning the file.
- Cursor, :145-151: file `~/.cursor/mcp.json` and entry shape match the docs. Risk (low): Cursor docs table lists `type` as required while the example omits it; adding `type: 'stdio'` would satisfy both readings but changes src test expectations (init.test.ts:374-405 deepEqual CURSOR_ENTRY).
- Codex, :153-246 and :240-246: table name, keys, file path all match. Text-edit approach avoids a TOML parser; quoted-key refusal (:155, :204-206) is correct since `"gsd-atlas"` equals the bare key in TOML.
- Stale comment, :142-144: says shapes "are not checked against current host documentation (research assumption A3)". This note now checks them; update the comment (and A3) after review.
- Risk: Windows paths for Cursor/Codex unconfirmed from docs; path.join(home, ...) at :146, :242 gives the conventional location. Command/args use absolute node paths, so Windows backslashes are handled by tomlString escaping (:168-181) and JSON.stringify.
- Risk: Codex TOML parsing edge cases in the text editor: `end` detection at :223 treats any line starting with `[` as a table end, which could cut inside a multi-line array or multi-line string whose line starts with `[` (e.g. a `[` continuation line inside `args = [` ... `]`). Not a doc mismatch; a robustness gap to consider testing.
- Not confirmed anywhere: restart requirements for Cursor and Codex CLI; init should print "restart your agent" without claiming a requirement.
