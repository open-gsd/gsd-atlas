// Round 3 harness (plan section 12 + amendments in FREEZE.md). Scores arms F, F2, L, D, E, W2, W3, R1, R2 on the macOS 27 SDK pack for V3 (vocabulary-gap) and I3 (identifier) sets.
// usage: node run-round3.mjs --data <sdk-dir> --v3 <gold-v3.json> --i3 <gold-i3.json> --targets <v3-targets.json> --backend llama|onnx --model <gguf-path|hf-id> --out <result.json> --cache <dir>
//        [--qprefix "..."] [--dprefix "..."] [--dtype q8] [--pooling mean] [--tag name] [--subpool <ids.json>]
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildFts, overlaps, tokens } from '../001-fts5-baseline-and-gold-queries/lib.mjs';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const qPrefix = A.qprefix ?? ''; const dPrefix = A.dprefix ?? '';
// amendment A1: dense text includes qualified owner and declaration/availability, as the lexical index does
const docText3 = (d) => `${d.name}. ${d.nameSplit}. ${d.qual}. ${d.sig.slice(0, 240)}. ${d.doc}`.slice(0, Number(A.maxchars ?? 1200));
const { docs: all } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8')); const fullPool = all.filter((d) => d.slice === 'a');
const sub = A.subpool ? new Set(JSON.parse(fs.readFileSync(A.subpool, 'utf8'))) : null;
const pool = sub ? fullPool.filter((d) => sub.has(d.id)) : fullPool; const byId = new Map(fullPool.map((d) => [d.id, d]));
const stratumOf = new Map(); { const t = JSON.parse(fs.readFileSync(A.targets, 'utf8')); for (const a of [...t.authors.flat(), ...t.reserve]) stratumOf.set(a[0], a[1]); }
const knownModules = new Set(fullPool.map((d) => d.fw.toLowerCase()));
const mk = (rows, kind) => rows.map(([id, q, rule]) => { const d = byId.get(id); if (!d) throw new Error(`unknown gold id ${id}`); return { id, q, rule, kind, stratum: kind === 'V3' ? stratumOf.get(id) : d.part, gold: id, name: d.name, nameSplit: d.nameSplit }; });
const fnv = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const split = (g) => (fnv(`${g.kind}|${g.id}`) % 10 < 3 ? 'tuning' : 'test');
const sets = A.embedonly ? {} : { V3: mk(JSON.parse(fs.readFileSync(A.v3, 'utf8')), 'V3'), I3: mk(JSON.parse(fs.readFileSync(A.i3, 'utf8')), 'I3') };

// ---- embedder
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };
let embed;
if (A.backend === 'llama') {
  const { getLlama } = await import('../002b-runtime-llamacpp/node_modules/node-llama-cpp/dist/index.js');
  const llama = await getLlama(); const ctx = await (await llama.loadModel({ modelPath: A.model })).createEmbeddingContext({ contextSize: Number(A.ctx ?? 1024) });
  embed = async (t) => norm((await ctx.getEmbeddingFor(t)).vector);
} else {
  const { pipeline, env } = await import('../002a-runtime-onnx-transformersjs/node_modules/@huggingface/transformers/dist/transformers.node.mjs');
  env.cacheDir = process.env.SPIKE_MODEL_CACHE; env.allowRemoteModels = process.env.ALLOW_REMOTE === '1';
  const ex = await pipeline('feature-extraction', A.model, { dtype: A.dtype ?? 'q8' });
  embed = async (t) => norm((await ex([t], { pooling: A.pooling ?? 'mean', normalize: true })).tolist()[0]);
}
// ---- document vectors (cached)
fs.mkdirSync(A.cache, { recursive: true });
const tag = A.tag ?? 'run'; const sig = createHash('sha256').update(JSON.stringify([A.backend, A.model, A.dtype, dPrefix, 'docText3', ...(A.maxchars ? [A.maxchars] : []), pool.length, pool[0].id, pool.at(-1).id])).digest('hex').slice(0, 12);
const vfile = path.join(A.cache, `${tag}-${sig}.f32`); let dim, dv, docsPerSec;
if (fs.existsSync(vfile)) { const b = fs.readFileSync(vfile); const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4); dim = f.length / pool.length; dv = pool.map((_, i) => f.subarray(i * dim, (i + 1) * dim)); docsPerSec = Number(fs.readFileSync(`${vfile}.txt`, 'utf8')); }
else {
  const t0 = performance.now(); let buf = null;
  for (let i = 0; i < pool.length; i++) { const v = await embed(dPrefix + docText3(pool[i])); if (!buf) { dim = v.length; buf = new Float32Array(pool.length * dim); } buf.set(v, i * dim); if (i % 5000 === 0) console.error(tag, 'embedded', i, '/', pool.length, `${((performance.now() - t0) / 1000).toFixed(0)}s`); }
  docsPerSec = pool.length / ((performance.now() - t0) / 1000); fs.writeFileSync(vfile, Buffer.from(buf.buffer)); fs.writeFileSync(`${vfile}.txt`, String(docsPerSec)); dv = pool.map((_, i) => buf.subarray(i * dim, (i + 1) * dim));
}
if (A.embedonly) { console.log(JSON.stringify({ tag, embeddedOnly: true, dim, pool: pool.length, docsPerSec: +docsPerSec.toFixed(1), vfile })); process.exit(0); }
// ---- retrieval pieces
const fts = buildFts(all, 'a');
const fts2db = new DatabaseSync(':memory:');
fts2db.exec(`CREATE VIRTUAL TABLE t USING fts5(name, nameSplit, qual, doc, sig, id UNINDEXED, tokenize='porter unicode61')`);
{ const ins = fts2db.prepare('INSERT INTO t(name,nameSplit,qual,doc,sig,id) VALUES (?,?,?,?,?,?)'); fts2db.exec('BEGIN'); for (const d of fullPool) ins.run(d.name, d.nameSplit, d.qual, d.doc, d.sig, d.id); fts2db.exec('COMMIT'); }
const sel2 = fts2db.prepare('SELECT id FROM t WHERE t MATCH ? ORDER BY bm25(t, 6.0, 4.0, 1.0, 1.0, 1.0), id LIMIT ?');
const f2search = (q, k = 50) => { const ts = tokens(q); if (!ts.length) return []; return sel2.all(ts.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR '), k).map((r) => r.id); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const K = 50;
const denseTop = (q) => {
  const ts = new Float64Array(K).fill(-Infinity); const ti = new Int32Array(K).fill(-1); let min = -Infinity, minAt = 0;
  for (let i = 0; i < pool.length; i++) {
    const s = dot(q, dv[i]); if (s < min) continue;
    // replace current minimum (ties: keep lower pool index, i.e. earlier id order is not guaranteed; resolve ties by id at the end)
    ts[minAt] = s; ti[minAt] = i; min = Infinity; for (let j = 0; j < K; j++) if (ts[j] < min) { min = ts[j]; minAt = j; }
  }
  return Array.from(ti).filter((i) => i >= 0).sort((a, b) => ts[Array.from(ti).indexOf(b)] - ts[Array.from(ti).indexOf(a)] || (pool[a].id < pool[b].id ? -1 : 1)).map((i) => pool[i].id);
};
const wrrf = (lex, den, w, k = 60) => { const m = new Map(); lex.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (k + i + 1))); den.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + w / (k + i + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 50).map((e) => e[0]); };
const IDENT = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const r1Ident = (q) => { const t = q.trim().split(/\s+/); return (t.length === 1 && IDENT.test(t[0])) || (t.length === 2 && IDENT.test(t[1]) && knownModules.has(t[0].toLowerCase())); };
const r2Hit = (q, lex) => { const top = byId.get(lex[0]); if (!top) return false; const x = q.trim().toLowerCase(); return x === top.name.toLowerCase() || x === `${top.owner}.${top.name}`.toLowerCase() || x === `${top.fw}.${top.name}`.toLowerCase(); };
const hit = (r, g, k) => { const p = r.indexOf(g); return p >= 0 && p < k ? 1 : 0; };
// ---- run all queries
const rows = []; const embedMs = []; const scanMs = []; const ftsMs = [];
for (const [name, golds] of Object.entries(sets)) for (const g of golds) {
  const t0 = performance.now(); const q = await embed(qPrefix + g.q); const t1 = performance.now(); const den = denseTop(q); const t2 = performance.now();
  const lexF = fts.search(g.q, 50); const t3 = performance.now(); const lexF2 = f2search(g.q, 50);
  embedMs.push(t1 - t0); scanMs.push(t2 - t1); ftsMs.push(t3 - t2);
  rows.push({ set: name, id: g.id, q: g.q, rule: g.rule, stratum: g.stratum, split: split(g), overlap: overlaps(g), lexF, lexF2, den });
}
const r10 = (rs, f) => rs.reduce((s, r) => s + hit(f(r), r.id, 10), 0) / (rs.length || 1);
const sel = (set, sp, extra = () => true) => rows.filter((r) => r.set === set && r.split === sp && extra(r));
// L: stronger of F / F2 on the V3 tuning half
const tuneF = r10(sel('V3', 'tuning'), (r) => r.lexF), tuneF2 = r10(sel('V3', 'tuning'), (r) => r.lexF2); const Lname = tuneF2 > tuneF + 1e-9 ? 'F2' : 'F';
const lexOf = (r) => (Lname === 'F2' ? r.lexF2 : r.lexF);
const armList = (r, arm) => {
  const lex = lexOf(r); const W = (w) => wrrf(lex, r.den, w);
  switch (arm) { case 'F': return r.lexF; case 'F2': return r.lexF2; case 'L': return lex; case 'D': return r.den; case 'E': return W(1); case 'W2': return W(2); case 'W3': return W(3);
    default: { const m = /^(R1|R2)w(\d)$/.exec(arm); const w = Number(m[2]); const route = m[1] === 'R1' ? r1Ident(r.q) : r2Hit(r.q, lex); return route ? lex : W(w); } }
};
const rr = (rs, arm) => r10(rs, (r) => armList(r, arm));
let bestW = 1, bestScore = -1; const tuneTable = {};
for (const w of [1, 2, 3]) { const sc = (rr(sel('V3', 'tuning'), `R2w${w}`) + rr(sel('I3', 'tuning'), `R2w${w}`)) / 2; tuneTable[w] = +sc.toFixed(4); if (sc > bestScore + 1e-9) { bestScore = sc; bestW = w; } }
const primary = `R2w${bestW}`;
const mulberry = (seed) => { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const boot = (rs, a, b) => { const d = rs.map((r) => hit(armList(r, a), r.id, 10) - hit(armList(r, b), r.id, 10)); const n = d.length; if (!n) return null; const r = mulberry(42); const m = []; for (let i = 0; i < 10000; i++) { let s = 0; for (let j = 0; j < n; j++) s += d[Math.floor(r() * n)]; m.push(s / n); } m.sort((x, y) => x - y); return { n, mean: +(d.reduce((x, y) => x + y, 0) / n).toFixed(4), p5: +m[500].toFixed(4), p95: +m[9500].toFixed(4) }; };
const ARMS = ['F', 'F2', 'L', 'D', 'E', 'W2', 'W3', 'R1w1', 'R1w2', 'R1w3', 'R2w1', 'R2w2', 'R2w3'];
const table = {}; for (const set of ['V3', 'I3']) for (const sp of ['tuning', 'test']) table[`${set}.${sp}`] = { n: sel(set, sp).length, ...Object.fromEntries(ARMS.map((a) => [a, +rr(sel(set, sp), a).toFixed(3)])) };
const vt = sel('V3', 'test'), it = sel('I3', 'test');
const strata = {}; for (const st of ['A', 'B', 'C', 'D']) { const rs = vt.filter((r) => r.stratum === st); strata[st] = { n: rs.length, L: +rr(rs, 'L').toFixed(3), D: +rr(rs, 'D').toFixed(3), primary: +rr(rs, primary).toFixed(3), primary_vs_L: boot(rs, primary, 'L') }; }
const parts = {}; for (const p of ['objc', 'swift']) { const rs = vt.filter((r) => byId.get(r.id).part === p); parts[p] = { n: rs.length, L: +rr(rs, 'L').toFixed(3), D: +rr(rs, 'D').toFixed(3), primary: +rr(rs, primary).toFixed(3) }; }
const perRule = {}; for (const r of it) (perRule[r.rule] ??= []).push(r); const perRuleI3 = Object.fromEntries(Object.entries(perRule).map(([k, rs]) => [k, { n: rs.length, L: +rr(rs, 'L').toFixed(3), primary: +rr(rs, primary).toFixed(3) }]));
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)]; const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.5)];
const added = embedMs.map((x, i) => x + scanMs[i] + ftsMs[i]);
const out = {
  tag, backend: A.backend, model: A.model, dtype: A.dtype ?? null, dim, poolSize: pool.length, docsPerSec: +docsPerSec.toFixed(1), embedSeconds: +(pool.length / docsPerSec).toFixed(0), L: Lname, tuneFvsF2: { F: tuneF, F2: tuneF2 }, tuneTable, bestWeight: bestW, primaryArm: primary, table,
  primaryTest: { V3_vs_L: boot(vt, primary, 'L'), V3_vs_F: boot(vt, primary, 'F'), V3_vs_F2: boot(vt, primary, 'F2'), V3_vs_E: boot(vt, primary, 'E'), V3_D_vs_L: boot(vt, 'D', 'L'), I3_vs_L: boot(it, primary, 'L'), I3_vs_F: boot(it, primary, 'F'), V3_BplusC_vs_L: boot(vt.filter((r) => r.stratum === 'B' || r.stratum === 'C'), primary, 'L') },
  strata, parts, perRuleI3, latencyMs: { embedP50: +p50(embedMs).toFixed(1), embedP95: +p95(embedMs).toFixed(1), scanP95: +p95(scanMs).toFixed(1), ftsP95: +p95(ftsMs).toFixed(1), addedP95: +p95(added).toFixed(1) },
  top10: Object.fromEntries(rows.map((r) => [`${r.set}|${r.id}`, { L: lexOf(r).slice(0, 10), D: r.den.slice(0, 10), primary: armList(r, primary).slice(0, 10), split: r.split }])),
  denseTop50: Object.fromEntries(rows.map((r) => [`${r.set}|${r.id}`, r.den])),
};
fs.writeFileSync(A.out, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ tag, dim, pool: pool.length, docsPerSec: out.docsPerSec, L: Lname, bestWeight: bestW, tune: tuneTable, latencyMs: out.latencyMs }));
console.table(table); console.log(JSON.stringify(out.primaryTest)); console.log(JSON.stringify(strata)); console.log(JSON.stringify(parts)); console.log(JSON.stringify(perRuleI3));
