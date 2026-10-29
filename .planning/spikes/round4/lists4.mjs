// Round 4: builds per-query candidate lists (top 50) for the base pack and the Swift-enriched pack (plan section 13).
// usage: node lists4.mjs --variant base|sw --data <dir with docs.json> --vec <base vectors .f32> --model <embedder gguf> --out <lists.json> [--cache <dir>]
// base: dense/lexical lists over the full pool and over Pool-lite. sw: same docs.json with enriched Swift prose; documents whose dense text changed are re-embedded, other vectors are reused.
import fs from 'node:fs'; import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildFts, overlaps, tokens } from '../001-fts5-baseline-and-gold-queries/lib.mjs';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const R3 = '../round3/queries/'; const R4 = 'queries/';
const dPrefix = 'title: none | text: ', qPrefix = 'task: search result | query: ';
const docText3 = (d) => `${d.name}. ${d.nameSplit}. ${d.qual}. ${d.sig.slice(0, 240)}. ${d.doc}`.slice(0, 1200);
const baseAll = JSON.parse(fs.readFileSync(path.join(path.dirname(A.vec), '../sdk27/docs.json'), 'utf8')).docs;
const { docs: all } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8'));
const fullPool = all.filter((d) => d.slice === 'a'); const basePool = baseAll.filter((d) => d.slice === 'a'); const byId = new Map(fullPool.map((d) => [d.id, d]));
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };
const { getLlama } = await import('../002b-runtime-llamacpp/node_modules/node-llama-cpp/dist/index.js');
const llama = await getLlama(); const ctx = await (await llama.loadModel({ modelPath: A.model })).createEmbeddingContext({ contextSize: 1024 });
const embed = async (t) => norm((await ctx.getEmbeddingFor(t)).vector);
// ---- document vectors: base from cache; sw re-embeds only changed texts
const b = fs.readFileSync(A.vec); const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4); const dim = f.length / basePool.length; if (!Number.isInteger(dim)) throw new Error('vector file does not match pool');
const dv = fullPool.map((_, i) => f.subarray(i * dim, (i + 1) * dim)); let reembedded = 0, reembedSec = 0;
if (A.variant === 'sw') {
  const cache = path.join(A.cache, 'sw-vectors.json'); const changed = []; fullPool.forEach((d, i) => { if (docText3(d) !== docText3(basePool[i])) changed.push(i); });
  const vf = path.join(A.cache, 'sw-changed.f32');
  if (fs.existsSync(vf)) { const bb = fs.readFileSync(vf); const ff = new Float32Array(bb.buffer, bb.byteOffset, bb.length / 4); changed.forEach((i, k) => { dv[i] = ff.subarray(k * dim, (k + 1) * dim); }); reembedSec = Number(fs.readFileSync(`${vf}.txt`, 'utf8')); }
  else { const t0 = performance.now(); const buf = new Float32Array(changed.length * dim); for (let k = 0; k < changed.length; k++) { buf.set(await embed(dPrefix + docText3(fullPool[changed[k]])), k * dim); if (k % 5000 === 0) console.error('sw embedded', k, '/', changed.length); } reembedSec = (performance.now() - t0) / 1000; fs.mkdirSync(A.cache, { recursive: true }); fs.writeFileSync(vf, Buffer.from(buf.buffer)); fs.writeFileSync(`${vf}.txt`, String(reembedSec)); changed.forEach((i, k) => { dv[i] = buf.subarray(k * dim, (k + 1) * dim); }); }
  reembedded = changed.length; void cache;
}
// ---- lexical
const fts = buildFts(all, 'a');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE VIRTUAL TABLE t USING fts5(name, nameSplit, qual, doc, sig, id UNINDEXED, tokenize='porter unicode61')`);
{ const ins = db.prepare('INSERT INTO t(name,nameSplit,qual,doc,sig,id) VALUES (?,?,?,?,?,?)'); db.exec('BEGIN'); for (const d of fullPool) ins.run(d.name, d.nameSplit, d.qual, d.doc, d.sig, d.id); db.exec('COMMIT'); }
const maj = (d) => (d.introduced ? parseInt(d.introduced, 10) : 0);
const lite = fullPool.map((d, i) => ((d.part === 'objc' && basePool[i].doc.length >= 40) || maj(d) >= 26 ? i : -1)).filter((i) => i >= 0);
if (A.variant === 'base' && lite.length !== 37293) throw new Error(`Pool-lite selected ${lite.length}, expected 37293`);
db.exec('CREATE TEMP TABLE lite(id TEXT PRIMARY KEY)'); { const ins = db.prepare('INSERT INTO lite VALUES (?)'); db.exec('BEGIN'); for (const i of lite) ins.run(fullPool[i].id); db.exec('COMMIT'); }
const selF2 = db.prepare('SELECT id FROM t WHERE t MATCH ? ORDER BY bm25(t, 6.0, 4.0, 1.0, 1.0, 1.0), id LIMIT ?');
const selF2Lite = db.prepare('SELECT id FROM t WHERE t MATCH ? AND id IN (SELECT id FROM lite) ORDER BY bm25(t, 6.0, 4.0, 1.0, 1.0, 1.0), id LIMIT ?');
const f2 = (st, q, k = 50) => { const ts = tokens(q); if (!ts.length) return []; return st.all(ts.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR '), k).map((r) => r.id); };
const dot = (a, c) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * c[i]; return s; };
const K = 50; const ALL = fullPool.map((_, i) => i);
const denseTop = (q, idxs) => {
  const ts = new Float64Array(K).fill(-Infinity); const ti = new Int32Array(K).fill(-1); let min = -Infinity, minAt = 0;
  for (const i of idxs) { const s = dot(q, dv[i]); if (s < min) continue; ts[minAt] = s; ti[minAt] = i; min = Infinity; for (let j = 0; j < K; j++) if (ts[j] < min) { min = ts[j]; minAt = j; } }
  return Array.from(ti).filter((i) => i >= 0).sort((a, c) => ts[Array.from(ti).indexOf(c)] - ts[Array.from(ti).indexOf(a)] || (fullPool[a].id < fullPool[c].id ? -1 : 1)).map((i) => fullPool[i].id);
};
// ---- queries
const strat = new Map(); for (const f2n of ['v3-targets.json', 'v3-targets-batch2.json']) { const t = JSON.parse(fs.readFileSync(R3 + f2n, 'utf8')); for (const a of [...t.authors.flat(), ...(t.reserve ?? [])]) strat.set(a[0], a[1]); }
{ const t = JSON.parse(fs.readFileSync(R4 + 'm4-targets.json', 'utf8')); for (const a of [...t.main, ...t.reserve]) strat.set(a[0], a[1]); }
const sets = { V3: JSON.parse(fs.readFileSync(R3 + 'gold-v3.json', 'utf8')), I3: JSON.parse(fs.readFileSync(R3 + 'gold-i3.json', 'utf8')), M4: JSON.parse(fs.readFileSync(R4 + 'gold-m4.json', 'utf8')) };
const fnv = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const out = { variant: A.variant, dim, poolSize: fullPool.length, liteSize: lite.length, reembedded, reembedSec: +reembedSec.toFixed(1), rows: [] };
for (const [set, rows] of Object.entries(sets)) for (const row of rows) {
  const [id, q, rule] = row; const d = byId.get(id); if (!d) throw new Error(`unknown id ${id}`);
  const t0 = performance.now(); const qv = await embed(qPrefix + q); const t1 = performance.now();
  const den = denseTop(qv, ALL); const t2 = performance.now(); const lexF = fts.search(q, 50); const lexF2 = f2(selF2, q); const t3 = performance.now();
  out.rows.push({ set, id, q, rule: rule ?? null, split: fnv(`${set}|${id}`) % 10 < 3 ? 'tuning' : 'test', stratum: set === 'I3' ? d.part : strat.get(id), part: d.part, inLite: lite.length && lite.includes(fullPool.indexOf(d)) ? 1 : 0, overlap: overlaps({ q, name: d.name, nameSplit: d.nameSplit }), lexF, lexF2, den, ms: { embed: t1 - t0, scan: t2 - t1, fts: t3 - t2 }, ...(A.variant === 'base' ? { denLite: denseTop(qv, lite), lexF2Lite: f2(selF2Lite, q) } : {}) });
}
fs.writeFileSync(A.out, JSON.stringify(out)); console.log(JSON.stringify({ variant: A.variant, rows: out.rows.length, reembedded, reembedSec: out.reembedSec }));
