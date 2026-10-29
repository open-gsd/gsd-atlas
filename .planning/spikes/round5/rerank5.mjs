// Round 5 Q6 (plan section 14.5): Qwen3-Reranker-0.6B over the top 50 / top 20 of the R3 lists of M5 and I5 queries (exact-name hits skip it).
// usage: node rerank5.mjs --data <dir> --plists primary-lists.json --reranker <gguf> --out rerank.json
import fs from 'node:fs'; import path from 'node:path';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const { getLlama } = await import('../002b-runtime-llamacpp/node_modules/node-llama-cpp/dist/index.js');
const { docs } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8')); const byId = new Map(docs.map((d) => [d.id, d]));
const docText3 = (d) => `${d.name}. ${d.nameSplit}. ${d.qual}. ${d.sig.slice(0, 240)}. ${d.doc}`.slice(0, 1200);
const pl = JSON.parse(fs.readFileSync(A.plists, 'utf8'));
const llama = await getLlama(); const rk = await (await llama.loadModel({ modelPath: A.reranker })).createRankingContext({ contextSize: 1024 });
const rerank = async (q, cand) => { const sc = await rk.rankAll(q, cand.map((id) => docText3(byId.get(id)))); return cand.map((id, i) => [id, sc[i]]).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map((e) => e[0]); };
const out = { model: path.basename(A.reranker), primary: pl.primary, lists: {}, latency: {} }; const ms50 = [], ms20 = []; let n = 0;
for (const [k, v] of Object.entries(pl.lists)) {
  if (v.keepLex) { out.lists[k] = { rr50: v.list, rr20: v.list, skipped: true }; continue; }
  const t0 = performance.now(); const rr50 = await rerank(v.q, v.list.slice(0, 50)); const t1 = performance.now(); const rr20 = await rerank(v.q, v.list.slice(0, 20)); const t2 = performance.now();
  ms50.push(t1 - t0); ms20.push(t2 - t1); out.lists[k] = { rr50, rr20 }; if (++n % 50 === 0) console.error('reranked', n);
}
// determinism: second run on 60 non-skipped queries (30 M5, 30 I5, first by key order)
const pick = (set, c) => Object.keys(out.lists).filter((k) => k.startsWith(`${set}|`) && !out.lists[k].skipped).sort().slice(0, c); const subset = [...pick('M5', 30), ...pick('I5', 30)]; let identical = 0;
for (const k of subset) { const again = await rerank(pl.lists[k].q, pl.lists[k].list.slice(0, 50)); if (JSON.stringify(again.slice(0, 10)) === JSON.stringify(out.lists[k].rr50.slice(0, 10))) identical++; }
out.determinism = { n: subset.length, identical };
const p = (a, q) => [...a].sort((x, y) => x - y)[Math.floor(a.length * q)]; out.latency = { rr50: { p50: +p(ms50, 0.5).toFixed(0), p95: +p(ms50, 0.95).toFixed(0) }, rr20: { p50: +p(ms20, 0.5).toFixed(0), p95: +p(ms20, 0.95).toFixed(0) }, queries: ms50.length };
fs.writeFileSync(A.out, JSON.stringify(out)); console.log(JSON.stringify({ latency: out.latency, determinism: out.determinism }));
