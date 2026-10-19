# About how atlas decides what to trust and what it never sends

gsd-atlas reads code its user did not write, runs a program that an agent can start, and puts text from repositories in front of a model. This page discusses why its trust rules are shaped the way they are: who can grant a permission, what an answer treats as untrusted, and why nothing leaves the machine. The exact commands and fields are in [the CLI reference](../reference/cli.md) and [the MCP reference](../reference/mcp.md); what is and is not built in this alpha is in [the alpha limitations](../reference/alpha-limitations.md).

## Why can a repository never enable a command?

A cloned repository, its dependencies and its language modules are all content that somebody else wrote. The [trust boundaries](../adr/3-trust-boundaries.md) record starts from three holes found in an early design: configuration committed to a repository could enable command execution, a localhost endpoint is reachable from web pages, and prose from repositories reached agents unfenced. The first of these gives the rule that shapes everything else: repository files can never enable a command, diagnostics or automatic submission. That covers repository configuration, a module's `precise.command`, a `package.json` with install scripts and any other file in the tree. The only source of permission is the configuration folder of the user, `~/.config/gsd-atlas` unless `GSD_ATLAS_USER_DIR` says otherwise.

The record states the point of the rule as a consequence: cloning and indexing a hostile repository cannot run its code or widen what atlas may do. The repository's own configuration file is still read, but only for settings that grant nothing, such as the list of directories that hold decision records. A key in it that names a permission, a command or a diagnostics setting is ignored, with a fixed diagnostic, and has no effect.

Git needed the same care, because git itself runs commands that a repository's configuration names, such as a clean filter or a file-system monitor. The [command runner](../adr/4-command-runner.md) and trust records therefore say that atlas starts git with those hooks neutralised and allows only read-side subcommands. The record adds that a test with a poisoned repository configuration shows that nothing is started.

## Why is an approval exact?

Some commands are legitimate, and a person may want atlas to run one. The record's answer is that the person approves it from the command line, where a human is present, and that the approval is as narrow as it can be made. `gsd-atlas allow` shows the exact argument list and the working directory, asks on a terminal and does nothing without one. What it writes binds the canonical path of the repository, the executable and a SHA-256 over the executable, the arguments and the working directory. A change to any of them no longer matches, and the command is denied until the person approves the new form. The command's sequence has the same effect: the confirming request carries the hash of what was shown, and the host writes only when the hash it computes itself is equal. What the person read is what is approved.

The approval is also only a gate. An approved command runs during `maintain resolve`, and atlas records how it ended; there is no importer that reads its output into the index. The [approval guide](../how-to/approve-a-precise-command.md) shows the steps.

## Why does the MCP server never run an unapproved command?

The MCP server is started by an agent's host, and the requests it answers come from a model. The record says plainly that MCP never prompts: a request that would need a command which is not built in is answered from the grammar tier, marked `needs_approval`, and the tier state that `explain` shows says what to run. The approval list does not apply to requests that arrive through MCP at all, unless a person started the server with `--allow-build`. With that flag an exact approved entry runs and nothing else does. The flag is given when the server is started, not in a request.

## Why does atlas load the project's own TypeScript?

The recorded rule is that the compiler worker loads the project's own installed TypeScript when that is a 6.x release. The worker then loads JavaScript that the repository's dependency tree supplies, and the trust record names that as a trust decision, with a residual risk it accepts and a way for the user to remove it. The reasoning, and what the child process does and does not contain, is in [About how the precise TypeScript tier works](how-the-precise-tier-works.md).

## What is untrusted text, and why is it fenced?

Everything that comes from a repository is attacker-influenced, and an answer reaches a model's context. So an answer carries repository text in one place only, `untrusted_text`, and each entry is wrapped in lines that carry a fresh random value for that response. Escape sequences and invisible control characters are stripped, lines are cut to a fixed width, and a line that contains the response's own random value is replaced. The code comment that introduces the fence is candid about its limit: it reduces prompt injection and cannot prevent it, and the tool descriptions say so too. The value cannot be guessed by whoever wrote the repository text, so the text cannot close its own fence.

## Why is there no telemetry, and why are diagnostics off by default?

The trust record sets the network rule in one line: none by default, and each fetch path would be its own switch under the user's control. The design for feedback follows from the same stance, and its record gives the problem and the answer. A project that sends nothing is blind to whether it works for anyone but its authors, and the goal is real feedback without collecting anything the user has not read and approved. So the design has no telemetry: a diagnostics report is something the user builds, reads and decides about, one data type at a time, every type starting denied, and each shown with the real values from the user's own machine before a choice is made.

That design is an accepted decision, and only part of it is built. The command line builds the report and shows it, and `--save` keeps it on the machine; this version never sends one, and the parts of the design about submission and about an intake on the repository side do not exist. The bug bundle follows the same stance: it is written to the user's cache, with names and paths hashed by default, and the person decides whether to attach it anywhere. Tests for `bug` and `diagnostics` replace the ways a Node program can open a connection with stubs that fail, and check that nothing tried.

## Why can agents not rate or report?

Ratings and reports are statements about what a person experienced. The recorded decision for ratings is short: users rate, not agents, so there is no MCP rating tool, and the host refuses a rating that arrives from an MCP server. Diagnostics follow the same line: the choices are read from the user's configuration folder and never from a repository, and a host started for an MCP server refuses the request to change them. The record says it in its own words, that agents can suggest and never submit. A rating carries no text: only the id of an answer, a feature or a session, and a value.

## See also

- [gsd-atlas alpha limitations reference](../reference/alpha-limitations.md)
- [How to approve a precise command for one repository](../how-to/approve-a-precise-command.md)
- [How to rate an answer, a feature or a session](../how-to/rate-an-answer.md)
- [How to report a bug](../how-to/report-a-bug.md)
- [How to turn diagnostics on and off](../how-to/turn-diagnostics-on-and-off.md)
- [About how the precise TypeScript tier works](how-the-precise-tier-works.md)
