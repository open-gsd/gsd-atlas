// Spike 006: Qwen3-Reranker-0.6B (GGUF Q8_0, node-llama-cpp) over the top-N of FTS5, dense, and hybrid candidates on the SDK slice.
// usage: node rerank.mjs <embedder-gguf> <reranker-gguf> <dataDir> <outFile> <queryPrefix>   env: D_PREFIX
import fs from 'node:fs'; import path from 'node:path';
import { getLlama } from '../002b-runtime-llamacpp/node_modules/node-llama-cpp/dist/index.js';
import { loadDocs, resolveGold, buildFts } from '../001-fts5-baseline-and-gold-queries/lib.mjs';
import { docText, rrf } from '../dense-lib.mjs';
const [embGguf, rrGguf, dataDir, outFile, qPrefix] = process.argv.slice(2);
const G = path.join(import.meta.dirname, '../001-fts5-baseline-and-gold-queries');
const docs = loadDocs(dataDir); const pool = docs.filter((d) => d.slice === 'a'); const byId = new Map(pool.map((d) => [d.id, d]));
const sets = { a2: resolveGold(docs, 'a', JSON.parse(fs.readFileSync(path.join(G, 'gold-a2.json'), 'utf8'))), a: resolveGold(docs, 'a', JSON.parse(fs.readFileSync(path.join(G, 'gold-a.json'), 'utf8'))) };
const llama = await getLlama();
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const emb = await (await llama.loadModel({ modelPath: embGguf })).createEmbeddingContext({ contextSize: 1024 });
const t0 = performance.now();
const dv = []; for (const d of pool) dv.push(norm((await emb.getEmbeddingFor((process.env.D_PREFIX ?? '') + docText(d))).vector));
const rrModel = await llama.loadModel({ modelPath: rrGguf });
const rk = await rrModel.createRankingContext({ contextSize: 1024 });
const fts = buildFts(docs, 'a');
const hit = (r, g, k) => { const p = r.indexOf(g); return p >= 0 && p < k ? 1 : 0; };
const out = { embedder: embGguf.split('/').pop(), reranker: rrGguf.split('/').pop(), sets: {} };
for (const [k, golds] of Object.entries(sets)) {
  const rows = []; const tq = performance.now(); let rerankMs = 0;
  for (const g of golds) {
    const q = norm((await emb.getEmbeddingFor(qPrefix + g.q)).vector);
    const dense = pool.map((d, i) => [d.id, dot(q, dv[i])]).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 50).map((e) => e[0]);
    const lex = fts.search(g.q, 50); const hyb = rrf([lex, dense]);
    const arms = { fts: lex, dense, hybrid: hyb };
    const rr = {};
    for (const [name, list] of Object.entries(arms)) {
      for (const N of [20, 50]) {
        const cand = list.slice(0, N); const tr = performance.now();
        const scores = await rk.rankAll(g.q, cand.map((id) => docText(byId.get(id))));
        rerankMs += performance.now() - tr;
        rr[`${name}+rr${N}`] = cand.map((id, i) => [id, scores[i]]).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map((e) => e[0]);
      }
    }
    rows.push({ gold: g.gold, lists: { ...arms, ...rr } });
  }
  const agg = {}; for (const key of Object.keys(rows[0].lists)) agg[key] = { r5: rows.reduce((s, r) => s + hit(r.lists[key], r.gold, 5), 0) / rows.length, r10: rows.reduce((s, r) => s + hit(r.lists[key], r.gold, 10), 0) / rows.length };
  out.sets[k] = { n: golds.length, agg, rerankMsPerQuery: +(rerankMs / golds.length / 6).toFixed(1) };
  console.log(k, JSON.stringify(Object.fromEntries(Object.entries(agg).map(([n, v]) => [n, +v.r10.toFixed(3)]))), 'rerank ms per call (avg of 6 calls/query):', out.sets[k].rerankMsPerQuery);
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
