# Spike Manifest

## Ideas

### embedding-retrieval-lane
Test whether an opt-in local embedding lane (plus optional reranker) over FTS5 raises recall on SDK-intent, ADR and code-symbol queries, within the A18 size and owner latency budgets, without touching the cited-exact-facts claim. Plan: `docs/research/embedding-retrieval-spike-plan.md`.

**Requirements:**

- Corpus pin: gsd-core at `10ac3a7a947903ba50f538a907af036744d759d5` (read-only archive in the scratchpad); ADR slice from this repo's `docs/adr/`; SDK slice from installed `@types/node`.
- Budgets (owner, 2026-10-28): p95 added query latency under 50 ms warm; index time under 10 minutes on CPU.
- MLX only via a spike-local venv, `.planning/spikes/.venv-mlx`, deleted when the spikes are complete.
- No product code, dependency, schema change or frozen file touched.

## Spikes

| # | Idea | Name | Type | Validates | Verdict | Tags |
|---|------|------|------|-----------|---------|------|
| 001 | embedding-retrieval-lane | fts5-baseline-and-gold-queries | standard | FTS5 baseline recall shows headroom | PARTIAL | fts5, baseline |
