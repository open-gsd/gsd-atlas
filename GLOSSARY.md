# gsd-atlas

A live, local map of a codebase and the platform SDKs it targets, served to coding agents. This glossary fixes the words used across the design docs and ADRs.

## Code facts

**Local fact**:
A fact derivable from one file's content alone, such as a definition, an import as written, or a reference site. Shared by every branch and worktree that has that content.
_Avoid_: raw fact, file fact

**Resolved edge**:
A reference bound to the definition it points at. Depends on the rest of the project, so it belongs to one overlay snapshot and resolution context.
_Avoid_: link, binding, resolved fact

**Overlay**:
The mapping from a worktree's or branch's paths to the content each path currently has.
_Avoid_: view, snapshot (a snapshot is one overlay at one moment)

**Symbol identity**:
What makes a symbol "the same symbol" across edits: its repo, path, qualified name, kind and overload discriminator. A symbol's content version is separate.
_Avoid_: symbol id, symbol hash

**Package**:
A unit of code distribution that files import from, such as an npm package or a Swift package.
_Avoid_: module (see **Language module**)

**Confidence**:
How certain a fact is: `EXTRACTED` (read directly or compiler-resolved) or `INFERRED` (matched by name).
_Avoid_: score, certainty

**Watermark**:
The point up to which a worktree's files have been indexed, attached to every answer.
_Avoid_: freshness token, version stamp

## Languages and tiers

**Language module**:
A data folder that teaches gsd-atlas a language: manifest, grammar, queries and fixtures. Always written "language module" in full.
_Avoid_: plugin, language pack, module (unqualified)

**Grammar Engine**:
The one shared implementation that runs every language module's grammar and queries and resolves references by name.
_Avoid_: parser, extractor

**Tier**:
A level of precision a language can reach: Grammar (always), Precise (optional), Platform (optional).
_Avoid_: level, mode

**Precise resolver**:
A pluggable source of compiler- or index-accurate resolved edges, such as a SCIP index or a compiler adapter, that supersedes name-matched edges at the same span.
_Avoid_: compiler tier, LSP

## Platform

**SDK provider**:
A registered source of platform API facts (Apple, Node, glibc, Go, and so on), chosen by a project's targets rather than by file extension.
_Avoid_: platform plugin, language platform

**SDK id**:
The identity of one installed SDK: platform, version, build and variant, so betas and variants never collide.
_Avoid_: SDK version

**Symbol key**:
A provider's own identifier for an SDK symbol. It is meaningful only within one SDK id.
_Avoid_: USR (an Apple-specific kind of symbol key)

**Availability**:
When an SDK symbol was introduced, deprecated, obsoleted or renamed, on one or more axes such as an OS or a browser.
_Avoid_: since-data, version info

## Running things

**Command runner**:
The single place where gsd-atlas starts an external program, and the only place that decides whether it may.
_Avoid_: executor, shell helper

**Built-in provider**:
A first-party provider shipped with gsd-atlas that runs a fixed, known command and is on by default.
_Avoid_: default plugin, trusted plugin

**Fact Store**:
The one module that holds, lifecycles and serves everything gsd-atlas has learned about a repo.
_Avoid_: database, index, cache

## Runtime structure

**Host**:
The one per-user process that accepts requests and builds a tenant for each repo.
_Avoid_: daemon, server

**Tenant**:
Everything held for one repo: its Source Tree, Fact Store, Indexer, Query and Policy. Isolated from every other repo's tenant.
_Avoid_: session, project

**Source Tree**:
The git-derived view of a worktree: which files count as source, their content hashes, what a file looked like at a commit, and the repo's identity.
_Avoid_: workspace, git layer

**Indexer**:
The module that turns file and git changes into stored facts and can bring named paths up to date on demand.
_Avoid_: watcher, crawler

**Governor**:
The one machine-wide scheduler that decides what runs when and within what memory budget.
_Avoid_: scheduler, resource manager

**Query**:
The module that turns a request into a ranked, cited, budgeted answer. MCP, CLI and hooks are only ways of calling it.
_Avoid_: search, API

**Policy**:
The module that decides whether an agent's action is allowed, adjusted or blocked, using what that agent has already done.
_Avoid_: enforcement, rules engine

**Workspace**:
A set of repos the user has declared may be queried together.
_Avoid_: monorepo, project group

## Value measurement

**Metrics**:
The module that records, locally and best-effort, what atlas did and what it cost, and builds the dashboard report from it.
_Avoid_: telemetry, analytics

**Dashboard**:
The local report of what atlas delivered and cost, where every figure is labeled by how it was obtained.
_Avoid_: scoreboard, ROI report

**Measured / Estimated / A/B**:
The three classes of figure. Measured is observed directly; estimated is modelled from a stated method with a range; A/B is a difference observed between runs with hooks off, advise and enforce.
_Avoid_: savings (unqualified)

**Context kept out**:
An estimate of how much file content an agent did not have to read because an atlas answer replaced a search or read.
_Avoid_: tokens saved
