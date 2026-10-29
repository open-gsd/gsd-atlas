// Shared dense-lane evaluation for the SDK slice. An embedder is {name, qPrefix, dPrefix, embed(texts: string[]) -> Promise<Float32Array[]>}.
import fs from 'node:fs'; import path from 'node:path';
import { loadDocs, resolveGold, buildFts, tokens } from './001-fts5-baseline-and-gold-queries/lib.mjs';
const here = import.meta.dirname; const G = path.join(here, '001-fts5-baseline-and-gold-queries');
export const docText = (d) => `${d.name}. ${d.nameSplit}. ${d.doc}`.slice(0, 1200);
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s; return o; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function mulberry(seed) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function rrf(lists, k = 60, top = 50) { const sc = new Map(); for (const l of lists) l.forEach((id, i) => sc.set(id, (sc.get(id) ?? 0) + 1 / (k + i + 1))); return [...sc.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top).map((e) => e[0]); }
const hit = (ranked, gold, k) => { const p = ranked.indexOf(gold); return p >= 0 && p < k ? 1 : 0; };
const mrr = (ranked, gold) => { const p = ranked.indexOf(gold); return p >= 0 ? 1 / (p + 1) : 0; };
function bootstrap(diffs, B = 10000, seed = 42) { const r = mulberry(seed); const n = diffs.length; const means = []; for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += diffs[Math.floor(r() * n)]; means.push(s / n); } means.sort((a, b) => a - b); return { p5: means[Math.floor(B * 0.05)], p50: means[Math.floor(B * 0.5)], p95: means[Math.floor(B * 0.95)] }; }

export async function evaluate(embedder, dataDir, outFile) {
  const docs = loadDocs(dataDir); const pool = docs.filter((d) => d.slice === 'a');
  const sets = { a2: resolveGold(docs, 'a', JSON.parse(fs.readFileSync(path.join(G, 'gold-a2.json'), 'utf8'))), a: resolveGold(docs, 'a', JSON.parse(fs.readFileSync(path.join(G, 'gold-a.json'), 'utf8'))) };
  const t0 = performance.now();
  const dv = (await embedder.embed(pool.map((d) => (embedder.dPrefix ?? '') + docText(d)), 'doc')).map(norm);
  const indexMs = performance.now() - t0;
  const fts = buildFts(docs, 'a'); const out = { embedder: embedder.name, dim: dv[0].length, poolSize: pool.length, indexMs: Math.round(indexMs), sets: {} };
  for (const [k, golds] of Object.entries(sets)) {
    const tq = performance.now();
    const qv = (await embedder.embed(golds.map((g) => (embedder.qPrefix ?? '') + g.q), 'query')).map(norm);
    const qMs = (performance.now() - tq) / golds.length;
    const dense = qv.map((q) => { const s = pool.map((d, i) => [d.id, dot(q, dv[i])]); s.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)); return s.slice(0, 50).map((e) => e[0]); });
    const lex = golds.map((g) => fts.search(g.q, 50));
    const hyb = golds.map((_, i) => rrf([lex[i], dense[i]]));
    const m = (rank) => ({ r5: golds.reduce((s, g, i) => s + hit(rank[i], g.gold, 5), 0) / golds.length, r10: golds.reduce((s, g, i) => s + hit(rank[i], g.gold, 10), 0) / golds.length, mrr: golds.reduce((s, g, i) => s + mrr(rank[i], g.gold), 0) / golds.length });
    const diffs = golds.map((g, i) => hit(hyb[i], g.gold, 10) - hit(lex[i], g.gold, 10));
    out.sets[k] = { n: golds.length, fts: m(lex), dense: m(dense), hybrid: m(hyb), hybridMinusFtsR10: diffs.reduce((a, b) => a + b, 0) / diffs.length, bootstrap: bootstrap(diffs), queryEmbedMsPerQuery: +qMs.toFixed(1), top10Hybrid: hyb.map((r) => r.slice(0, 10)) };
  }
  // determinism: second run of query embedding must give identical top-10 on a2
  const qv2 = (await embedder.embed(sets.a2.map((g) => (embedder.qPrefix ?? '') + g.q), 'query')).map(norm);
  const again = qv2.map((q) => { const s = pool.map((d, i) => [d.id, dot(q, dv[i])]); s.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)); return s.slice(0, 50).map((e) => e[0]); });
  const lexA2 = sets.a2.map((g) => fts.search(g.q, 50)); const hybA2 = sets.a2.map((_, i) => rrf([lexA2[i], again[i]]));
  out.deterministicTop10 = JSON.stringify(hybA2.map((r) => r.slice(0, 10))) === JSON.stringify(out.sets.a2.top10Hybrid);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  const f = (x) => +x.toFixed(3);
  for (const [k, v] of Object.entries(out.sets)) console.log(embedder.name, k, JSON.stringify({ n: v.n, ftsR10: f(v.fts.r10), denseR10: f(v.dense.r10), hybridR10: f(v.hybrid.r10), lift: f(v.hybridMinusFtsR10), ci5_50_95: [f(v.bootstrap.p5), f(v.bootstrap.p50), f(v.bootstrap.p95)], qMs: v.queryEmbedMsPerQuery }));
  console.log(embedder.name, 'dim', out.dim, 'indexMs', out.indexMs, 'docs', out.poolSize, 'deterministic', out.deterministicTop10);
  return out;
}
