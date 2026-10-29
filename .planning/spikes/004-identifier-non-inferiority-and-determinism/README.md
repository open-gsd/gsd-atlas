---
spike: 004
idea: embedding-retrieval-lane
name: identifier-non-inferiority-and-determinism
type: standard
validates: "Given the hybrid from 003, when identifier-like queries and repeat runs are checked, then recall@10 loses less than 1 point and top-10 lists are identical"
verdict: PARTIAL
related: [001, 003]
tags: [non-inferiority, determinism]
---

# Spike 004: non-inferiority and determinism

- **Determinism: passed.** Every arm (bge-small, EmbeddingGemma v1, EmbeddingGemma 2, Qwen3 on ONNX, GGUF and MLX) reproduced identical hybrid top-10 lists on a second query-embedding pass, on one machine and backend.
- **Non-inferiority on doc-worded SDK queries (set a, n 29): passed.** Hybrid recall@10 is 0.931 to 0.966 against FTS5 0.897, so no arm loses ground.
- **Non-inferiority on identifier-like queries: not tested in this narrowed spike.** The SDK gold sets contain no identifier-style queries, and the earlier c1 identifier slice (code, 40 queries) was at ceiling for FTS5 alone (recall@10 1.000) but was dropped when scope narrowed to the SDK slice. Because dense-only beat the hybrid on a2 (see 003), a dense lane that replaces rather than augments FTS5 would put exact-name lookups at risk; that risk is unmeasured.

**Verdict: PARTIAL.** Determinism and doc-worded non-inferiority hold; identifier non-inferiority is an open gap that must be closed before any adoption decision (add an SDK identifier-query set and re-run the hybrid).
