// Round 3 C7/C8: dense-only recall@10 and brute-force scan time on the full SDK pack for float32 768, int8 768 and int8 256 (MRL truncation, renormalised), plus storage bytes.
// usage: node quant3.mjs <sdk-dir> <vectors.f32> <embedder-gguf> <out.json>
import fs from 'node:fs'; import path from 'node:path';
const [dataDir, vfile, gguf, outFile] = process.argv.slice(2);
const { getLlama } = await import('../002b-runtime-llamacpp/node_modules/node-llama-cpp/dist/index.js');
const { docs } = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs.json'), 'utf8')); const pool = docs.filter((d) => d.slice === 'a');
const b = fs.readFileSync(vfile); const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4); const dim = f.length / pool.length;
const fnv = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const test = (kind, id) => fnv(`${kind}|${id}`) % 10 >= 3;
const qs = [...JSON.parse(fs.readFileSync('queries/gold-v3.json', 'utf8')).filter(([id]) => test('V3', id)).map(([id, q]) => ({ set: 'V3', id, q })), ...JSON.parse(fs.readFileSync('queries/gold-i3.json', 'utf8')).filter(([id]) => test('I3', id)).map(([id, q]) => ({ set: 'I3', id, q }))];
const llama = await getLlama(); const ctx = await (await llama.loadModel({ modelPath: gguf })).createEmbeddingContext({ contextSize: 1024 });
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };
const qv = []; for (const q of qs) qv.push(norm((await ctx.getEmbeddingFor('task: search result | query: ' + q.q)).vector));
const trunc = (v, n) => norm(v.subarray(0, n));
const toI8 = (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127 * 3))));
function build(mode, n) {
  if (mode === 'f32') { const out = new Float32Array(pool.length * n); for (let i = 0; i < pool.length; i++) out.set(n === dim ? f.subarray(i * dim, (i + 1) * dim) : trunc(f.subarray(i * dim, (i + 1) * dim), n), i * n); return out; }
  const out = new Int8Array(pool.length * n); for (let i = 0; i < pool.length; i++) out.set(toI8(n === dim ? f.subarray(i * dim, (i + 1) * dim) : trunc(f.subarray(i * dim, (i + 1) * dim), n)), i * n); return out;
}
const res = [];
for (const [mode, n] of [['f32', dim], ['int8', dim], ['int8', 256]]) {
  const M = build(mode, n); const times = []; const hits = { V3: [0, 0], I3: [0, 0] };
  qs.forEach((q, qi) => {
    const qe = mode === 'f32' ? (n === dim ? qv[qi] : trunc(qv[qi], n)) : toI8(n === dim ? qv[qi] : trunc(qv[qi], n));
    const t0 = performance.now(); const K = 10; const ts = new Float64Array(K).fill(-Infinity); const ti = new Int32Array(K).fill(-1); let min = -Infinity, at = 0;
    for (let i = 0, o = 0; i < pool.length; i++, o += n) { let s = 0; for (let j = 0; j < n; j++) s += qe[j] * M[o + j]; if (s <= min) continue; ts[at] = s; ti[at] = i; min = Infinity; for (let j = 0; j < K; j++) if (ts[j] < min) { min = ts[j]; at = j; } }
    times.push(performance.now() - t0);
    hits[q.set][1]++; if (Array.from(ti).some((i) => i >= 0 && pool[i].id === q.id)) hits[q.set][0]++;
  });
  const sorted = [...times].sort((a, b2) => a - b2);
  res.push({ mode, dim: n, bytesPerVector: mode === 'f32' ? n * 4 : n, fullPoolMB: +((mode === 'f32' ? n * 4 : n) * pool.length / 1e6).toFixed(1), scanP50ms: +sorted[Math.floor(sorted.length / 2)].toFixed(1), scanP95ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1), V3test_denseR10: +(hits.V3[0] / hits.V3[1]).toFixed(3), I3test_denseR10: +(hits.I3[0] / hits.I3[1]).toFixed(3), nV3: hits.V3[1], nI3: hits.I3[1] });
}
console.table(res); fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
