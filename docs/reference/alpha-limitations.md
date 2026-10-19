# gsd-atlas alpha limitations reference

What this alpha of gsd-atlas does and does not do, and the status of its decision records and of its evaluation. The page states facts and gives no instructions; the guides and the other references are linked where a fact has one.

## Status

- This release is an alpha. The package version is 0.0.0.
- The commands, the MCP tools and the stored index format can change between builds. An index written by an earlier development build is derived data: the build that opens it deletes and recreates it, and the repository reports `not_indexed` until `gsd-atlas build` has run once (see [how to keep the store healthy](../how-to/keep-the-store-healthy.md)).
- No compatibility between builds, no release date and no registry release are promised.

## Supported

### Platforms

Windows is not supported in the alpha. gsd-atlas is built and tested on macOS and Linux. The Windows CI jobs run but are allowed to fail, and known Windows failures are listed in the project's planning notes. Windows support is planned after the alpha.

### Node and git

Node 24.16.0 or newer, and `git` on the path. CI runs Node 24.16.0 and 26 on Linux and macOS.

### Languages

The `typescript` module reads `.ts`, `.cts` and `.mts` files. The `javascript` module reads `.js`, `.cjs`, `.mjs` and `.jsx` files. A file that no module claims, such as a `.tsx` file, is not indexed. See [the TypeScript support reference](typescript-support.md#modules-and-files).

### Commands and tools

The command line has `find`, `refs`, `context`, `impact`, `explain`, `history`, `health`, `build`, `maintain`, `status`, `rate`, `init`, `allow`, `diagnostics`, `bug`, `lang list` and `lang test` ([the CLI reference](cli.md)). The MCP server offers seven tools over stdio: `code_find`, `code_refs`, `code_context`, `code_impact`, `code_explain`, `atlas_status` and `lang_list` ([the MCP reference](mcp.md)).

### Precise tier

The precise tier asks the TypeScript compiler. It is on by default for the `typescript` module. It uses the project's own TypeScript when that is a 6.x release, and otherwise the 6.0.3 copy that ships with gsd-atlas. A project with TypeScript 7.x is detected and answered by the shipped 6.0.3 copy, and the answer is `degraded` with `compiler_fallback`. A file that no usable `tsconfig.json` covers is answered by the grammar tier, and the answer carries `precise_unavailable`. See [the TypeScript support reference](typescript-support.md#compiler-selection).

### Feedback

`gsd-atlas rate`, `gsd-atlas bug` and `gsd-atlas diagnostics` work on this machine and send nothing. See [how to rate an answer, a feature or a session](../how-to/rate-an-answer.md), [how to report a bug](../how-to/write-a-bug-bundle.md) and [how to turn diagnostics on and off](../how-to/turn-diagnostics-on-and-off.md).

### Approved commands

A language module can declare a `precise.command`. It runs only after the user approves that exact command for one repository with `gsd-atlas allow`, and only its exit status, signal, time-out flag and duration are reported, never its output. See [the CLI reference](cli.md#gsd-atlas-allow).

## Not available

- **Windows.** Windows is not supported in the alpha; see [Platforms](#platforms).
- **A TypeScript 7.x resolver.** A 7.x project is answered by the shipped 6.0.3 compiler.
- **An importer for a module's `precise.command`.** The command is gated by approval and only its exit status, signal, time-out flag and duration are reported.
- **Submission or automatic intake of diagnostics.** A diagnostics report and a bug bundle are files on this machine. Nothing is submitted.
- **An MCP rating tool.** `gsd-atlas rate` is a command that a person runs; the host refuses it from an MCP server.
- **SDK facts.** No SDK pack exists, and no built-in module has a `platform` tier.
- **Swift.** No Swift module exists.
- **A per-user host with hardening.** The command line runs the host inside its own process and starts no background service.
- **Hooks and enforcement.** Nothing installs a hook or requires an agent to use the atlas tools. `gsd-atlas init` registers the MCP server and copies no skills.
- **The dashboard.** `gsd-atlas status` prints local metrics as JSON; no dashboard exists.
- **Resolved references between packages.** References between the packages of a multi-package repository are not claimed.

## Privacy

- gsd-atlas opens no network connection when it indexes a repository or answers a question, and it sends no telemetry.
- Diagnostics are off by default, each data type is approved separately, and a report is a local file. `gsd-atlas bug` writes a bundle on this machine and uploads nothing.
- Permissions come only from the user's own configuration folder, never from a repository. The reasons are in [about how atlas decides what to trust](../explanation/how-atlas-decides-what-to-trust.md).

## Decision records

The decision records under [docs/adr](../adr/README.md) are drafts for this alpha, and no decision record is ratified. The project owner recorded on 2026-10-18 that "nothing is ratified as it's not done". A ratification step is planned; this page promises no date and no condition for it.

Older records still carry an Accepted status line, an issue number and a numbered file name from before that rule. Read them as drafts for this alpha, not as ratified. The legend in [docs/adr/README.md](../adr/README.md#pre-release-legend) explains each.

The diagnostics design is a draft: [the user-controlled diagnostics record](../adr/draft-user-controlled-diagnostics.md) and the design document [docs/DIAGNOSTICS.md](../DIAGNOSTICS.md). Their submission and automatic-intake parts do not exist in this release.

## Evaluation status

The registered evaluation is complete. Its registered verdict is quoted from [the analysis](../eval/analysis.md):

```text
OVERALL: MVP not met
```

The accuracy criterion was met. The token criterion was not met. The citation criterion was not met. Further development that the project gates on this evaluation is blocked until a new registered run meets the gate.

The atlas arm had the gsd-atlas tools and the gsd-atlas skill, which the model could see and load, and the grep arm had neither. The design is in [the pre-registration](../eval/preregistration.md).

The figures are copied from the analysis, which holds the rules and the other figures:

| Criterion | Atlas arm | Grep arm | Result |
| --- | --- | --- | --- |
| Accuracy | 0.8000 | 0.7511 | met |
| Mean billable tokens per session | 47375.1 | 29393.1 | not met |
| Non-abstain sessions with verifiable citations | 72.7% | 73.7% | not met (threshold 80.0%) |

[The diagnosis](../eval/diagnosis.md) is a separate, descriptive document and does not change the verdict.
