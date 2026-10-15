# ADR: Host process model — one host per user, repos as tenants

- **Status:** Proposed
- **Issue:** to be opened (rename to `<issue#>-host-process-model.md`)
- **DESIGN.md:** A22–A28, A39–A43, A46, A49
- **Review findings addressed:** H‑1, H‑2, H‑3, H‑4, H‑5, S‑2, SDK‑3, L‑4

## Context
Developers run several repos at once, each with its own sessions, and agent tools spawn hundreds of short‑lived agents. Any design with a per‑agent or per‑repo runtime eventually hits a memory wall; any hard limit eventually gets hit. The design review found five gaps:
- repos pinned to different gsd‑atlas versions;
- a localhost HTTP endpoint reachable from web pages;
- static hook settings with no stable address;
- one crash taking atlas away from every repo;
- private packages leaking between repos through the shared package store.

## Decision
1. **One gsd‑atlas host per user and major version** serves every repo. Started by the first client (lock election), unloads idle repos after 10 minutes, exits when nothing is active. A small supervisor restarts it on crash.
2. **Versioned protocol:** clients and host exchange a protocol version on connect. Each major version runs its own host (`~/.cache/gsd-atlas/host-<major>/`). Stores record their schema version; an older host refuses a newer store with a clear message.
3. **Repos are isolated tenants:** own store, writer, lock, queues, policy and watchdog. A stuck tenant is unloaded without affecting the others. Repo id = root commit hash + a random store id written on first index; the path is only a lookup key.
4. **Shared public facts stored once per machine:** `sdk.db` (by SDK id incl. build and variant) and `pkg.db` (public‑registry packages by ecosystem, name and lockfile integrity hash), reference‑counted. Private, scoped‑private, git, workspace and patched packages stay in the repo's own store.
5. **Small, bounded cost per agent; no caps.**
   - Requests are stateless; per‑agent cost is a connection, an MCP session and a bounded ledger entry.
   - Zero extra processes on hosts with HTTP MCP and HTTP hooks. Stdio‑only clients pay one thin shim; hosts without HTTP hooks pay one thin forwarder per tool call.
   - No per‑agent index, cache or compiler; no hard‑coded limits. Limits are configurable back‑pressure, never caps.
6. **Work scales with change, not agents:** index queue keyed by (worktree, path) holding the latest hash; events coalesce; writes group‑committed.
7. **One machine‑wide resource governor:** memory budget (default 25 % of RAM) for compilers, plus parser and compiler pools.
8. **Scheduling:** per‑tenant queues with weighted round‑robin across tenants and a per‑tenant concurrency cap derived from the governor; inside a tenant, priority classes: interactive reads > fresh requests > indexing > maintenance. Per‑query time limits; `busy` with `retry_after` when saturated.
9. **Transport and endpoint security:**
   - **Endpoints:** a Unix domain socket (macOS, Linux) or named pipe (Windows) where the client supports it; otherwise 127.0.0.1 at a fixed, configurable per‑user port, so static hook settings can find it.
   - **Authentication:** every route, including hooks and health, requires the token from a `0600` file.
   - **Browser defence:** `Host` and `Origin` are validated and browser‑style requests rejected.
   - **Hooks:** hook configs read the token from an allowed environment variable or the token file.
10. **Read your own writes:** every response carries a watermark; `fresh` paths are indexed before answering.
11. **Isolation by default:** cross‑repo queries only within a workspace declared in user config (submodules join automatically), by fan‑out across stores (never `ATTACH`, which stops at 10).
12. **Disk budgets:** per‑repo and workstation (default 2 GB); cold repo stores dropped after 30 days and rebuilt on use.
13. **Visibility:** `status` and the SessionStart brief report when atlas is down or a tenant is degraded.

## Evidence (2026‑10‑15, prototype; re‑measured with the MCP SDK at M1)
- Per‑agent processes: 44 MB per read‑only process; 357 MB for a TypeScript program over gsd‑core.
- Prototype daemon (JSON‑lines over a Unix socket) at 1,000 concurrent short‑lived agents: 0 errors, ~31K queries/s, p99 97 ms, 134 MB, writes ongoing.
- 10 repos: 848 MB as 10 processes vs 89 MB in one host.
- SQLite `ATTACH`: refused at the 11th database.

## Consequences
- Memory independent of repo count and agent count; disk grows with unique content only.
- Different gsd‑atlas majors run side by side; the cost is one extra host per major in use.
- Supervisor and per‑tenant watchdogs add moving parts but contain failures.
- Unix sockets and named pipes need per‑OS transport code; HTTP stays as the fallback.

## Alternatives considered
- **Process and store per repo:** memory and compiler budgets add up per repo; shared facts duplicate.
- **One store for everything:** one corruption or lock affects all repos; removing a repo is surgery.
- **MCP server per agent (stdio):** memory grows linearly with agents.
- **One host for all versions:** forces lockstep upgrades across every repo.
- **Random port per start:** static hook settings can't find it.
