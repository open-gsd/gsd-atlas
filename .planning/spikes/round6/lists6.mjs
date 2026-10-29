// Round 6 list builder: same as round5/lists5.mjs but for the I6 set only (replay sets reuse round 5 lists).
// usage: node lists5.mjs --data <dir with docs.json> --vec <base vectors .f32> --model <embedder gguf> --qprefix "<prefix>" --out <lists.json>
import fs from 'node:fs'; import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildFts, tokens } from '../001-fts5-baseline-and-gold-queries/lib.mjs';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const R3 = '../round3/queries/', R4 = '../round4/queries/', R5 = '../round5/queries/', R6 = 'queries/';
const { docs: all } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8'));
const pool = all.filter((d) => d.slice === 'a'); const byId = new Map(pool.map((d) => [d.id, d]));
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };
const { getLlama } = await import('../002b-runtime-llamacpp/node_modules/node-llama-cpp/dist/index.js');
const llama = await getLlama(); const ctx = await (await llama.loadModel({ modelPath: A.model })).createEmbeddingContext({ contextSize: 1024 });
const embedRaw = async (t) => norm((await ctx.getEmbeddingFor(t)).vector);
const b = fs.readFileSync(A.vec); const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4); const dim = f.length / pool.length; if (!Number.isInteger(dim)) throw new Error('vector file does not match pool');
const dv = pool.map((_, i) => f.subarray(i * dim, (i + 1) * dim));
// int8 at 256 dimensions: MRL truncation, renormalised, scaled by 127*3 and rounded (as round3/quant3.mjs)
const toI8 = (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127 * 3))));
const trunc = (v, n) => norm(v.subarray(0, n)); const N8 = 256; const M8 = new Int8Array(pool.length * N8); for (let i = 0; i < pool.length; i++) M8.set(toI8(trunc(dv[i], N8)), i * N8);
// lexical
const fts = buildFts(all, 'a'); const db = new DatabaseSync(':memory:');
db.exec(`CREATE VIRTUAL TABLE t USING fts5(name, nameSplit, qual, doc, sig, id UNINDEXED, tokenize='porter unicode61')`);
{ const ins = db.prepare('INSERT INTO t(name,nameSplit,qual,doc,sig,id) VALUES (?,?,?,?,?,?)'); db.exec('BEGIN'); for (const d of pool) ins.run(d.name, d.nameSplit, d.qual, d.doc, d.sig, d.id); db.exec('COMMIT'); }
const selF2 = db.prepare('SELECT id FROM t WHERE t MATCH ? ORDER BY bm25(t, 6.0, 4.0, 1.0, 1.0, 1.0), id LIMIT ?');
const f2 = (q, k = 50) => { const ts = tokens(q); if (!ts.length) return []; return selF2.all(ts.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR '), k).map((r) => r.id); };
const K = 50;
const topK = (score, n) => { // generic top-K with the round 3 tie rule (score desc, id asc)
  const ts = new Float64Array(K).fill(-Infinity); const ti = new Int32Array(K).fill(-1); let min = -Infinity, minAt = 0;
  for (let i = 0; i < n; i++) { const s = score(i); if (s < min) continue; ts[minAt] = s; ti[minAt] = i; min = Infinity; for (let j = 0; j < K; j++) if (ts[j] < min) { min = ts[j]; minAt = j; } }
  return Array.from(ti).filter((i) => i >= 0).sort((a, c) => ts[Array.from(ti).indexOf(c)] - ts[Array.from(ti).indexOf(a)] || (pool[a].id < pool[c].id ? -1 : 1)).map((i) => pool[i].id);
};
const denseF32 = (q) => { const d = q.length; return topK((i) => { const v = dv[i]; let s = 0; for (let j = 0; j < d; j++) s += q[j] * v[j]; return s; }, pool.length); };
const denseI8 = (q8) => topK((i) => { let s = 0; const o = i * N8; for (let j = 0; j < N8; j++) s += q8[j] * M8[o + j]; return s; }, pool.length);
// queries
const strat = new Map(); for (const fn of ['v3-targets.json', 'v3-targets-batch2.json']) { const t = JSON.parse(fs.readFileSync(R3 + fn, 'utf8')); for (const a of [...t.authors.flat(), ...(t.reserve ?? [])]) strat.set(a[0], a[1]); }
for (const [dir, fn] of [[R4, 'm4-targets.json'], [R5, 'm5-targets.json']]) { const t = JSON.parse(fs.readFileSync(dir + fn, 'utf8')); for (const a of [...t.main, ...t.reserve]) strat.set(a[0], a[1]); }
const sets = { I6: JSON.parse(fs.readFileSync(R6 + 'gold-i6.json', 'utf8')) };
const fnv = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const out = { model: path.basename(A.model), dim, poolSize: pool.length, rows: [] };
for (const [set, rows] of Object.entries(sets)) for (const [id, q, rule] of rows) {
  const d = byId.get(id); if (!d) throw new Error(`unknown id ${id}`);
  const t0 = performance.now(); const qv = await embedRaw((A.qprefix ?? '') + q); const t1 = performance.now();
  const den = denseF32(qv); const t2 = performance.now(); const q8 = toI8(trunc(qv, N8)); const denQ = denseI8(q8); const t3 = performance.now();
  const lexF2 = f2(q); const t4 = performance.now(); const lexF = fts.search(q, 50);
  out.rows.push({ set, id, q, rule: rule ?? null, split: fnv(`${set}|${id}`) % 10 < 3 ? 'tuning' : 'test', stratum: set === 'I3' || set === 'I5' || set === 'I6' ? d.part : strat.get(id), part: d.part, lexF, lexF2, den, denQ, ms: { embed: t1 - t0, scanF32: t2 - t1, scanI8: t3 - t2, f2: t4 - t3 } });
}
fs.writeFileSync(A.out, JSON.stringify(out)); console.log(JSON.stringify({ model: out.model, rows: out.rows.length }));
