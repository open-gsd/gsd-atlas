// Round 2 harness (plan section 11, frozen). Scores arms F, D, E, W2, W3, R1, R2 on Pool B for V2 (vocabulary-gap) and I1 (identifier) sets.
// usage: node run-round2.mjs --data <poolb-dir> --v2 <v2.json> --i1 <i1.json> --backend llama|onnx --model <gguf-path|hf-id> --out <result.json> --cache <vectors-cache-dir>
//        [--qprefix "..."] [--dprefix "..."] [--dtype q8] [--pooling mean] [--tag name]
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto';
import { buildFts, overlaps } from '../001-fts5-baseline-and-gold-queries/lib.mjs';
import { docText } from '../dense-lib.mjs';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const qPrefix = A.qprefix ?? ''; const dPrefix = A.dprefix ?? '';
const { docs: all } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8')); const pool = all.filter((d) => d.slice === 'a'); const byId = new Map(pool.map((d) => [d.id, d]));
const ownerOf = (d) => (d.part === 'tslib' ? d.id.split(':').slice(4).join(':').replace(/\.[^.]+$/, '') : '');
const modOf = (d) => (d.part === 'tslib' ? (ownerOf(d) && ownerOf(d) !== d.name ? ownerOf(d) : d.qual.split('#')[0].replace(/^lib\./, '')) : d.qual.replace(/\.d$/, '').replace(/^.*\//, ''));
const knownModules = new Set(pool.map((d) => modOf(d).toLowerCase()));
const mk = (rows, kind) => rows.map(([id, q, rule]) => { const d = byId.get(id); if (!d) throw new Error(`unknown gold id ${id}`); return { id, q, rule, kind, gold: id, name: d.name, nameSplit: d.nameSplit }; });
const fnv = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const split = (g) => (fnv(`${g.kind}|${g.id}`) % 10 < 3 ? 'tuning' : 'test');
const sets = { V2: mk(JSON.parse(fs.readFileSync(A.v2, 'utf8')), 'V2'), I1: mk(JSON.parse(fs.readFileSync(A.i1, 'utf8')), 'I1') };

// ---- embedder
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };
let embed;
if (A.backend === 'llama') {
  const { getLlama } = await import('../002b-runtime-llamacpp/node_modules/node-llama-cpp/dist/index.js');
  const llama = await getLlama(); const ctx = await (await llama.loadModel({ modelPath: A.model })).createEmbeddingContext({ contextSize: 1024 });
  embed = async (t) => norm((await ctx.getEmbeddingFor(t)).vector);
} else {
  const { pipeline, env } = await import('../002a-runtime-onnx-transformersjs/node_modules/@huggingface/transformers/dist/transformers.node.mjs');
  env.cacheDir = process.env.SPIKE_MODEL_CACHE; env.allowRemoteModels = process.env.ALLOW_REMOTE === '1';
  const ex = await pipeline('feature-extraction', A.model, { dtype: A.dtype ?? 'q8' });
  embed = async (t) => norm((await ex([t], { pooling: A.pooling ?? 'mean', normalize: true })).tolist()[0]);
}
// ---- document vectors (cached)
fs.mkdirSync(A.cache, { recursive: true });
const tag = A.tag ?? 'run'; const sig = createHash('sha256').update(JSON.stringify([A.backend, A.model, A.dtype, dPrefix, pool.length, pool[0].id, pool.at(-1).id])).digest('hex').slice(0, 12);
const vfile = path.join(A.cache, `${tag}-${sig}.f32`); let dim, dv, docsPerSec;
if (fs.existsSync(vfile)) { const b = fs.readFileSync(vfile); const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4); dim = f.length / pool.length; dv = pool.map((_, i) => f.subarray(i * dim, (i + 1) * dim)); docsPerSec = Number(fs.readFileSync(`${vfile}.txt`, 'utf8')); }
else {
  const t0 = performance.now(); const vs = []; for (let i = 0; i < pool.length; i++) { vs.push(await embed(dPrefix + docText(pool[i]))); if (i % 1000 === 0) console.error(tag, 'embedded', i, '/', pool.length); }
  docsPerSec = pool.length / ((performance.now() - t0) / 1000); dim = vs[0].length; const buf = new Float32Array(pool.length * dim); vs.forEach((v, i) => buf.set(v, i * dim)); fs.writeFileSync(vfile, Buffer.from(buf.buffer)); fs.writeFileSync(`${vfile}.txt`, String(docsPerSec)); dv = vs;
}
// ---- retrieval pieces
const fts = buildFts(all, 'a'); const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const denseTop = (q) => { const sc = new Float32Array(pool.length); for (let i = 0; i < pool.length; i++) sc[i] = dot(q, dv[i]); const idx = Array.from(sc.keys()).sort((a, b) => sc[b] - sc[a] || (pool[a].id < pool[b].id ? -1 : 1)).slice(0, 50); return idx.map((i) => pool[i].id); };
const wrrf = (lex, den, w, k = 60) => { const m = new Map(); lex.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (k + i + 1))); den.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + w / (k + i + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 50).map((e) => e[0]); };
const IDENT = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const r1Ident = (q) => { const t = q.trim().split(/\s+/); return (t.length === 1 && IDENT.test(t[0])) || (t.length === 2 && IDENT.test(t[1]) && knownModules.has(t[0].toLowerCase())); };
const r2Hit = (q, lex) => { const top = byId.get(lex[0]); if (!top) return false; const x = q.trim().toLowerCase(); return x === top.name.toLowerCase() || x === `${ownerOf(top)}.${top.name}`.toLowerCase() || x === `${modOf(top)}.${top.name}`.toLowerCase(); };
const hit = (r, g, k) => { const p = r.indexOf(g); return p >= 0 && p < k ? 1 : 0; };
// ---- run all queries
const rows = []; const embedMs = []; const scanMs = [];
for (const [name, golds] of Object.entries(sets)) for (const g of golds) {
  const t0 = performance.now(); const q = await embed(qPrefix + g.q); const t1 = performance.now(); const den = denseTop(q); const t2 = performance.now();
  const lex = fts.search(g.q, 50); const t3 = performance.now();
  embedMs.push(t1 - t0); scanMs.push((t2 - t1) + (t3 - t2));
  const W = { 1: wrrf(lex, den, 1), 2: wrrf(lex, den, 2), 3: wrrf(lex, den, 3) };
  rows.push({ set: name, id: g.id, q: g.q, rule: g.rule, split: split(g), overlap: overlaps(g), lists: { F: lex, D: den, E: W[1], W2: W[2], W3: W[3], R1w1: r1Ident(g.q) ? lex : W[1], R1w2: r1Ident(g.q) ? lex : W[2], R1w3: r1Ident(g.q) ? lex : W[3], R2w1: r2Hit(g.q, lex) ? lex : W[1], R2w2: r2Hit(g.q, lex) ? lex : W[2], R2w3: r2Hit(g.q, lex) ? lex : W[3] } });
}
const r10 = (rs, arm) => rs.reduce((s, r) => s + hit(r.lists[arm], r.id, 10), 0) / (rs.length || 1);
const sel = (set, sp, extra = () => true) => rows.filter((r) => r.set === set && r.split === sp && extra(r));
// weight tuned on tuning halves only: mean of V2 and I1 recall@10 of R1(w)
let bestW = 1, bestScore = -1; const tuneTable = {};
for (const w of [1, 2, 3]) { const sc = (r10(sel('V2', 'tuning'), `R1w${w}`) + r10(sel('I1', 'tuning'), `R1w${w}`)) / 2; tuneTable[w] = +sc.toFixed(4); if (sc > bestScore + 1e-9) { bestScore = sc; bestW = w; } }
const primary = `R1w${bestW}`;
// bootstrap
const mulberry = (seed) => { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const boot = (rs, a, b) => { const d = rs.map((r) => hit(r.lists[a], r.id, 10) - hit(r.lists[b], r.id, 10)); const n = d.length; if (!n) return null; const r = mulberry(42); const m = []; for (let i = 0; i < 10000; i++) { let s = 0; for (let j = 0; j < n; j++) s += d[Math.floor(r() * n)]; m.push(s / n); } m.sort((x, y) => x - y); return { n, mean: +(d.reduce((x, y) => x + y, 0) / n).toFixed(4), p5: +m[500].toFixed(4), p95: +m[9500].toFixed(4) }; };
const ARMS = ['F', 'D', 'E', 'W2', 'W3', 'R1w1', 'R1w2', 'R1w3', 'R2w1', 'R2w2', 'R2w3'];
const table = {}; for (const set of ['V2', 'I1']) for (const sp of ['tuning', 'test']) table[`${set}.${sp}`] = { n: sel(set, sp).length, ...Object.fromEntries(ARMS.map((a) => [a, +r10(sel(set, sp), a).toFixed(3)])) };
const ptest = sel('V2', 'test'), itest = sel('I1', 'test');
const byAuthorRule = {}; for (const r of itest) { const k = r.rule; (byAuthorRule[k] ??= []).push(r); }
const perRule = Object.fromEntries(Object.entries(byAuthorRule).map(([k, rs]) => [k, { n: rs.length, F: +r10(rs, 'F').toFixed(3), primary: +r10(rs, primary).toFixed(3) }]));
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
const out = {
  tag, backend: A.backend, model: A.model, dtype: A.dtype ?? null, dim, poolSize: pool.length, docsPerSec: +docsPerSec.toFixed(1), tuneTable, bestWeight: bestW, primaryArm: primary, table,
  primaryTest: { V2_vs_F: boot(ptest, primary, 'F'), V2_vs_E: boot(ptest, primary, 'E'), V2_nameOverlap_vs_F: boot(ptest.filter((r) => r.overlap), primary, 'F'), I1_vs_F: boot(itest, primary, 'F') }, perRuleI1Test: perRule,
  latencyMs: { embedP50: +[...embedMs].sort((a, b) => a - b)[Math.floor(embedMs.length / 2)].toFixed(1), embedP95: +p95(embedMs).toFixed(1), scanAndFtsP95: +p95(scanMs).toFixed(1), addedP95: +p95(embedMs.map((x, i) => x + scanMs[i])).toFixed(1) },
  top10: Object.fromEntries(rows.map((r) => [`${r.set}|${r.id}`, { F: r.lists.F.slice(0, 10), D: r.lists.D.slice(0, 10), primary: r.lists[primary].slice(0, 10), split: r.split }])),
};
fs.writeFileSync(A.out, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ tag, dim, docsPerSec: out.docsPerSec, bestWeight: bestW, tune: tuneTable, latencyMs: out.latencyMs }));
console.table(table); console.log(JSON.stringify(out.primaryTest)); console.log(JSON.stringify(perRule));
