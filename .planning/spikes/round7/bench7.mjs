// Round 7 (plan section 16): embed throughput variants on a fixed 3,000-document sample, with the fidelity gate against the round 3 vectors.
// usage: node bench7.mjs --data <dir> --vec <round3 f32> --model <gguf> --dprefix "title: none | text: " --out bench.json
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { execSync } from 'node:child_process';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const { getLlama } = await import('../002b-runtime-llamacpp/node_modules/node-llama-cpp/dist/index.js');
const { docs: all } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8')); const pool = all.filter((d) => d.slice === 'a');
const docText3 = (d) => `${d.name}. ${d.nameSplit}. ${d.qual}. ${d.sig.slice(0, 240)}. ${d.doc}`.slice(0, 1200);
const text = (d) => A.dprefix + docText3(d);
const fnv = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };
const bytes = fs.readFileSync(A.vec); const base = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4); const dim = base.length / pool.length;
const sample = pool.map((d, i) => ({ d, i })).filter((x) => fnv(x.d.id) % 48 === 0).sort((a, b) => (a.d.id < b.d.id ? -1 : 1)).slice(0, 3000);
const host = () => { let idle = null; try { idle = Number(/([\d.]+)% idle/.exec(execSync('top -l 1 -n 0 | grep "CPU usage"').toString())[1]); } catch { /* ignore */ } return { load1: +os.loadavg()[0].toFixed(2), cpuIdle: idle }; };
const llama = await getLlama(); const model = await llama.loadModel({ modelPath: A.model });
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// longest token length over the full pack (plan 16.2, T4 eligibility)
let maxTokens = 0; { const c = await model.createEmbeddingContext({ contextSize: 1024 }); for (const d of pool) maxTokens = Math.max(maxTokens, c.calculateInputLength(text(d))); await c.dispose(); }

async function run(v, items) {
  const ctxs = []; for (let k = 0; k < v.n; k++) ctxs.push(await model.createEmbeddingContext({ contextSize: v.ctx, ...(v.batch ? { batchSize: v.batch } : {}) }));
  const order = v.longestFirst ? [...items].sort((a, b) => text(b.d).length - text(a.d).length || (a.d.id < b.d.id ? -1 : 1)) : items;
  const out = new Map(); let next = 0;
  const t0 = performance.now();
  await Promise.all(ctxs.map(async (c) => { for (;;) { const j = next++; if (j >= order.length) return; out.set(order[j].i, norm((await c.getEmbeddingFor(text(order[j].d))).vector)); } }));
  const ms = performance.now() - t0; for (const c of ctxs) await c.dispose(); return { ms, out };
}
const fidelity = (out) => { let sum = 0, min = 2, n = 0; for (const [i, v] of out) { let s = 0; for (let k = 0; k < dim; k++) s += v[k] * base[i * dim + k]; sum += s; if (s < min) min = s; n++; } return { mean: +(sum / n).toFixed(6), min: +min.toFixed(6), n }; };

const res = { sample: sample.length, dim, maxTokens, host0: host(), variants: [] };
async function measure(v) {
  await run(v, sample.slice(0, 100)); // warm-up, excluded
  const runs = []; let fid = null;
  for (let r = 0; r < 3; r++) { const h0 = host(); const { ms, out } = await run(v, sample); const h1 = host(); runs.push({ docsPerSec: +(sample.length / (ms / 1000)).toFixed(1), h0, h1 }); if (!fid) fid = fidelity(out); }
  const row = { ...v, docsPerSec: median(runs.map((r) => r.docsPerSec)), runs, fidelity: fid, fidelityPass: fid.mean >= 0.9999 && fid.min >= 0.999 }; res.variants.push(row);
  console.error(v.name, JSON.stringify({ dps: row.docsPerSec, fid, pass: row.fidelityPass })); return row;
}
const passing = () => res.variants.filter((r) => r.fidelityPass);
const best = (rows) => rows.reduce((a, b) => (b.docsPerSec > a.docsPerSec ? b : a));
await measure({ name: 'T0', n: 1, ctx: 1024 });
await measure({ name: 'T1', n: 1, ctx: 1024, batch: 2048 });
for (const n of [2, 4, 8]) await measure({ name: `T2-n${n}`, n, ctx: 1024 });
const t2 = res.variants.filter((r) => r.name.startsWith('T2') && r.fidelityPass); const bestN = t2.length ? best(t2).n : 1;
await measure({ name: `T3-n${bestN}`, n: bestN, ctx: 1024, longestFirst: true });
const b = best(passing()); const c4 = maxTokens <= 256 ? 256 : maxTokens <= 512 ? 512 : null;
if (c4) await measure({ name: `T4-ctx${c4}`, n: b.n, ctx: c4, batch: b.batch, longestFirst: b.longestFirst }); else res.t4 = `void: full-pack max tokens ${maxTokens} exceeds 512`;
const win = best(passing()); res.best = { name: win.name, n: win.n, ctx: win.ctx, batch: win.batch ?? null, longestFirst: !!win.longestFirst, docsPerSec: win.docsPerSec, projectedFullPackSeconds: +(pool.length / win.docsPerSec).toFixed(0) }; res.e1 = win.docsPerSec >= 244; res.hostEnd = host();
fs.writeFileSync(A.out, JSON.stringify(res, null, 1)); console.log(JSON.stringify({ best: res.best, e1: res.e1, maxTokens }));
