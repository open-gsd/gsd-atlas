# Review: Memtrace Cortex (decision memory, "dreaming", ADR governance) against gsd-atlas

Supplementary to `memory-tools-evidence-2026-10.md`. Unregistered, not scored. Sources: the hosted Memtrace docs, read through the Memtrace docs tools on 2026-10-22: `features/cortex`, `cli/govern`, `cli/cortex` (via a cited answer), `mcp/overview`. Everything under "What Cortex does" is the vendor's documentation, not something I ran or measured. I did not run Cortex against our repo.

## What Cortex does (vendor docs)

- **Purpose.** Decision memory kept apart from the code graph: it answers "was this decided on purpose?", "did the decision hold?", "what governs this symbol?". Recall comes from decisions captured from episode history (commits and saves), not from re-reading source at query time.
- **Five MCP tools,** proxied by the normal `memtrace mcp` server to a local sidecar (`memcortex-daemon`) over a Unix socket or named pipe: `recall_decision` (free-text recall), `verify_intent` (Held, ViolatedAt or CannotProve, takes a decision id), `get_arc` (the episodes that implemented a decision), `why_is_this_here` (lineage of a symbol), `governing_contracts` (Contract nodes that constrain a symbol). Tools return an explicit CannotProve instead of inventing an answer. Recall is scoped to the workspace root.
- **Ingest.** Capture is deliberately recall-heavy. A fine-tuned on-device classifier called Aletheia (DeBERTa-v3-large, 435M parameters, INT8 ONNX about 642 MB, about 1.2 GB resident) scores candidates. The vendor reports 0.933 AUC on held-out data, trained on 24,895 multi-judge-labelled examples (vendor figure, not verified).
- **"Dreaming".** This is the name of the idle consolidation pass of the daemon, shown in the dashboard's dreaming panel. It does not delete or rewrite memory. It scores freshly captured candidates, writes verdicts to `gate_verdicts.json`, and the recall path omits candidates classified as noise. The graph stays append-only. Fail-open: if the model cannot load, candidates are kept. So "dreaming" here is a noise filter, not a summarising or reorganising memory.
- **ADR handling ("governance intake", beta).** `memtrace govern <path|glob>` classifies ADRs, standing rules and agent-rule files (`*.md`, `*.mdc`, `.cursorrules`, `.windsurfrules`) through the same classifier the automatic intake uses. A sweep is a read-only preview (safe in CI); `--accept-all` persists the whole batch to `.memtrace/governance.toml`. `govern add|edit` asserts one doc by hand (type adr, agent_rule or standing_rule; guidance text; scope selectors such as `path:`, `lang:`; `--ban` makes a hard constraint, a Contract node). Governance-origin decisions skip the Aletheia gate. Automatic capture finds only git-tracked docs. ADR status is classified (effective or ineffective ADR), not inferred from file naming.

## Where gsd-atlas stands against it

| Area | Cortex | gsd-atlas today |
| --- | --- | --- |
| ADR as a fact | Reads and classifies the ADR text; keeps guidance, scope and ban flag; recalls by free text. | Joins an ADR number in a code comment to an ADR file name only. "No ADR document is read, indexed or returned" (`docs/reference/adr-citations.md`). It answers "which code cites ADR n", not "what does ADR n require". |
| Status of a decision | Effective vs ineffective ADRs, bans as Contract nodes, `verify_intent` across history. | None. The repo's own ADRs are append-only with dated amendments, which atlas does not model. |
| Governing rules per file | `governing_contracts`, `why_is_this_here` | None. |
| History | Episodes per decision (`get_arc`). | Not in the 1.0 scope of the map. |
| Noise control | Learned gate, local model, about 1.2 GB resident. | Not applicable: atlas does not capture conversation. |
| "Dreaming" | Idle pass that filters candidates. | No such feature in this repo. The only "dream" in gsd-core is the questioning philosophy for project initialisation, unrelated. |
| Trust boundary | Local sidecar, no network for inference. | Repo text is untrusted and fenced (trust-boundaries ADR). Returning ADR text would need the same fencing. |

## What this means for the project

1. **No benchmark in the evidence note measures decision memory,** and Cortex publishes none in the pages I read (only the classifier's AUC). Its value cannot be compared with our token and accuracy results. It also cannot be dismissed on the same evidence.
2. **It targets a different failure than our eval.** Our eval asks structural questions that grep can answer from names. Cortex targets "why is this here" and "is this banned", which grep cannot answer at all. A question set of that kind (for example "does any change in the last 30 days violate ADR n?", "what governs this file?") is untested by us and, as far as I found, by anyone.
3. **ADR management is the one place where atlas has an obvious thin spot.** Citations are file-name joins. A narrow, local, deterministic next step would be: read ADR front matter and status lines (Accepted, Superseded, amendment dates) and return them with the cited-by list. That is a design option to test, not a recommendation; it is not "memory".
4. **"Dreaming" is a design question, not a gap to copy.** The vendor's version is a classifier-driven filter for noisy auto-capture. Atlas has no auto-capture. If a consolidation step is ever wanted, the decision to make first is whether the map should hold decisions at all or leave them to a sibling tool. Cortex shows a cost: a 435M-parameter model and a second store with its own reset path.
5. **Do not adopt Cortex's claims into ours.** Aletheia's AUC is a classifier metric on its own labelled data. It says nothing about whether agents answer better with it.

## What I could not verify

- Any behaviour of Cortex in practice: I did not install it for this note or run its tools on our ADRs.
- The Aletheia figures (AUC, training set, footprint) are the vendor's.
- Whether the Memtrace plugin on this machine already ingests this repo's ADRs: I did not run `memtrace govern` (it persists nothing without `--accept-all`, but it needs the sidecar running).
- No published evaluation of decision memory against a baseline was found in these docs.

## Cheap checks that would settle it (owner's decision)

1. Run `memtrace govern docs/adr` as a read-only preview on this repo and look at how it classifies our 14 ADRs and their amendments. This tests whether a classifier reads append-only amendment sections correctly.
2. Draft 10 "why/ban/status" questions on this repo's own ADRs, keyed by hand, and see how `recall_decision` and atlas's ADR lookup do. Unscored, in the style of the earlier probes.
