# API Coverage — @modelcontextprotocol/server 2.3.1 and @parcel/watcher 2.6.0

> Full coverage by default. Opt-outs are explicit, reasoned decisions. Phase 2 integrates two third-party libraries (no remote service): the MCP TypeScript SDK v2 server package behind `gsd-atlas-mcp` (plan 02-23) and the native file watcher behind the Indexer (plan 02-17). Capability ids are prefixed with the library.

| capability | decision | reason |
|---|---|---|
| mcp-sdk:McpServer construction with name, version and capabilities | INTEGRATE | |
| mcp-sdk:registerTool with zod input schema | INTEGRATE | |
| mcp-sdk:tool annotations (readOnlyHint) | INTEGRATE | |
| mcp-sdk:server instructions | INTEGRATE | |
| mcp-sdk:stdio transport (serveStdio) | INTEGRATE | |
| mcp-sdk:tool call results with isError | INTEGRATE | |
| mcp-sdk:Streamable HTTP transport (createMcpHandler, @modelcontextprotocol/node) | OPT-OUT | explicitly out of scope: the socket and HTTP Host is Phase 4 (D-01); human decision not to install @modelcontextprotocol/node |
| mcp-sdk:resources | OPT-OUT | not in the default six-tool profile (D-07); revisit after the Phase 3 evaluation |
| mcp-sdk:prompts | OPT-OUT | routing guidance is the Agent Skill (Phase 3) and the server instructions, not MCP prompts |
| mcp-sdk:completions | OPT-OUT | no tool argument benefits from completion |
| mcp-sdk:sampling | OPT-OUT | deprecated in spec 2026-07-28; the product is deliberately LLM-free |
| mcp-sdk:roots | OPT-OUT | deprecated in spec 2026-07-28; the repository arrives as an explicit repo or cwd tool argument |
| mcp-sdk:elicitation | OPT-OUT | read-only tools never ask the user anything |
| mcp-sdk:logging capability | OPT-OUT | deprecated; the server writes nothing to protocol channels and nothing to stdout except frames |
| mcp-sdk:progress notifications and cancellation | OPT-OUT | answers are bounded by budget and ceiling, and saturation is reported as busy with retry_after |
| mcp-sdk:structuredContent and outputSchema | OPT-OUT | the envelope is returned as one text item so CLI and MCP output are byte-identical (QRY-04) |
| mcp-sdk:protocol sessions, resumability and legacy SSE | OPT-OUT | removed from the protocol in spec 2026-07-28; the server is stateless by design |
| parcel-watcher:subscribe with ignore globs | INTEGRATE | |
| parcel-watcher:unsubscribe | INTEGRATE | |
| parcel-watcher:writeSnapshot and getEventsSince | INTEGRATE | |
| parcel-watcher:backend selection option | OPT-OUT | not needed: the default per-OS backend is used and Reconcile is the correctness backstop |
