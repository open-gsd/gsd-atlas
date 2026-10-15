# ADR: Trust boundaries

- **Status:** Proposed
- **Issue:** to be opened (rename to `<issue#>-trust-boundaries.md`)
- **DESIGN.md:** A9, A16, A27, A44
- **Review findings addressed:** S‑1, S‑2, S‑3, S‑4, SDK‑1

## Context
gsd‑atlas indexes code the user didn't write: cloned repos, dependencies, SDKs. It runs a local server reachable by other processes, and it feeds text into agents that act on it. The design review found three holes in earlier drafts:
- repo‑committed config or modules could enable command execution;
- a localhost HTTP endpoint is reachable from web pages;
- repo and package prose reached agents unfenced.

## Decision
1. **Where permission comes from.**

   | Source | Can grant permissions? |
   |--------|------------------------|
   | User‑level config (`~/.config/gsd-atlas/`) | Yes: commands, network fetches (`history.allow_fetch`, SDK packs), workspaces, policy overrides |
   | Repo‑committed config (`.gsd-atlas/`) | No. Only data: excludes, module selection, policy *suggestions* the user can accept |
   | Repo or npm language modules | No. Grammars (sandboxed WebAssembly) and queries are data; their commands need user approval per repo and per command |
   | Agents | No. Policy overrides come only from the user |

\1 All of them start through one CommandRunner that alone decides permission from a provider's `CommandSpec` ([draft-command-runner](draft-command-runner.md)). The TypeScript adapter's in‑process load of the project's `typescript` is a sandboxed built‑in: worker, no network, tsconfig `plugins` ignored.
3. **Endpoint.**
   - Unix socket or named pipe preferred; loopback HTTP at a fixed port otherwise.
   - A token is required on every route.
   - `Host` and `Origin` are validated and browser‑style requests rejected.
   - The token file is `0600`.
4. **Untrusted text.**
   - All repo‑, package‑ and SDK‑derived prose is untrusted data.
   - It is fenced in tool responses (`untrusted_text`), length‑capped, redacted, and never placed unfenced into hook context.
   - It is scanned with gsd‑core's read‑injection patterns; matches are flagged in the response.
5. **Secrets.** gsd‑graph's redaction runs on every stored prose field and identifier label before storage.
6. **Network.** None by default. Each fetch path (history, SDK packs) is a separate user‑level switch.

## Consequences
- Cloning and indexing a hostile repo can't run its code or widen atlas's permissions.
- Web pages can't reach the host.
- A first‑time user gets the Apple SDK features without configuration, while third‑party commands stay off.
- Users approve third‑party commands once per repo; a small prompt cost.

## Alternatives considered
- **All commands opt‑in (earlier draft):** the headline SDK feature was off by default.
- **Trust repo config:** remote code execution on index.
- **HTTP with token only:** DNS rebinding and simple cross‑site requests still reach unauthenticated routes.
