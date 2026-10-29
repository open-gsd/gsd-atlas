// Round 8 (plan 17.2, 17.5): product-shaped path R6-nolex = map exact lookup + int8-256 dense + trigram only when the R6 trigger fires (R5 trigger and the query has no dot). Times three passes and writes the lists of pass 1.
// usage: node latency8.mjs --data <dir> --vec <base .f32> --model <gguf> --qprefix "<prefix>" --out <json>
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { execSync } from 'node:child_process';
import { buildFts } from '../001-fts5-baseline-and-gold-queries/lib.mjs';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const { docs: all } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8')); const pool = all.filter((d) => d.slice === 'a');
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };
const { getLlama } = await import('../002b-runtime-llamacpp/node_modules/node-llama-cpp/dist/index.js');
const llama = await getLlama(); const ctx = await (await llama.loadModel({ modelPath: A.model })).createEmbeddingContext({ contextSize: 1024 });
const embedRaw = async (t) => norm((await ctx.getEmbeddingFor(t)).vector);
const b = fs.readFileSync(A.vec); const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4); const dim = f.length / pool.length;
const toI8 = (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127 * 3)))); const N8 = 256;
const M8 = new Int8Array(pool.length * N8); for (let i = 0; i < pool.length; i++) M8.set(toI8(norm(f.subarray(i * dim, i * dim + N8))), i * N8);
const fts = buildFts(all, 'a');
// exact-name map: name, owner.name, fw.name (lowercase) -> ids
const emap = new Map(); const add = (k, id) => { k = k.toLowerCase(); const a = emap.get(k); if (a) a.push(id); else emap.set(k, [id]); };
for (const d of pool) { add(d.name, d.id); if (d.owner) add(`${d.owner}.${d.name}`, d.id); add(`${d.fw}.${d.name}`, d.id); }
const host = () => { try { return Number(/([\d.]+)% idle/.exec(execSync('top -l 1 -n 0 | grep "CPU usage"').toString())[1]); } catch { return null; } };
const K = 50;
const topK = (score, n) => { const ts = new Float64Array(K).fill(-Infinity); const ti = new Int32Array(K).fill(-1); let min = -Infinity, minAt = 0;
  for (let i = 0; i < n; i++) { const s = score(i); if (s < min) continue; ts[minAt] = s; ti[minAt] = i; min = Infinity; for (let j = 0; j < K; j++) if (ts[j] < min) { min = ts[j]; minAt = j; } }
  return Array.from(ti).filter((i) => i >= 0).sort((a, c) => ts[Array.from(ti).indexOf(c)] - ts[Array.from(ti).indexOf(a)] || (pool[a].id < pool[c].id ? -1 : 1)).map((i) => pool[i].id); };
const denseI8 = (q8) => topK((i) => { let s = 0; const o = i * N8; for (let j = 0; j < N8; j++) s += q8[j] * M8[o + j]; return s; }, pool.length);
const wrrf = (lex, den, w, k = 60) => { const m = new Map(); lex.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (k + i + 1))); den.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + w / (k + i + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 50).map((e) => e[0]); };
const fnv = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const Q = [['../round3/queries/gold-v3.json', 'V3', 'test'], ['../round4/queries/gold-m4.json', 'M4', 'test'], ['../round5/queries/gold-m5.json', 'M5', 'test'], ['../round5/queries/gold-i5.json', 'I5', 'test'], ['../round6/queries/gold-i6.json', 'I6', 'all'], ['queries/gold-i8.json', 'I8', 'all']]
  .flatMap(([fn, set, which]) => JSON.parse(fs.readFileSync(fn, 'utf8')).filter(([id]) => which === 'all' || fnv(`${set}|${id}`) % 10 >= 3).map(([id, q, rule]) => ({ set, id, q, rule: rule ?? null })));
const run = async (r) => {
  const q = r.q.trim(); const t0 = performance.now(); const qv = await embedRaw((A.qprefix ?? '') + r.q); const t1 = performance.now();
  const q8 = toI8(norm(qv.subarray(0, N8))); const den = denseI8(q8); const t2 = performance.now();
  const hit = emap.get(q.toLowerCase()); const t3 = performance.now();
  let list, trig = false, tf = 0;
  if (hit) list = [...new Set([...[...hit].sort(), ...den])].slice(0, 50);
  else if (!/\s/.test(q) && q.length >= 5 && !q.includes('.')) { trig = true; const a = performance.now(); const lex = fts.search(r.q, 50); tf = performance.now() - a; list = wrrf(lex, den, 1); } else list = den;
  const t4 = performance.now();
  return { list, trig, exact: !!hit, ms: { embed: t1 - t0, scan: t2 - t1, map: t3 - t2, trigram: tf, total: t4 - t0 } };
};
await run(Q[0]); // warm-up, excluded
const out = { n: Q.length, passes: [], rows: [] };
for (let p = 0; p < 3; p++) {
  const idle0 = host(); const load = os.loadavg()[0]; const ms = [];
  for (const r of Q) { const o = await run(r); ms.push({ set: r.set, ...o.ms, trig: o.trig, exact: o.exact }); if (p === 0) out.rows.push({ set: r.set, id: r.id, q: r.q, rule: r.rule, trig: o.trig, exact: o.exact, list: o.list }); }
  out.passes.push({ load1: load, cpuIdle: idle0, load1End: os.loadavg()[0], cpuIdleEnd: host(), ms });
}
fs.writeFileSync(A.out, JSON.stringify(out)); console.log(JSON.stringify({ n: Q.length, loads: out.passes.map((p) => p.load1) }));
