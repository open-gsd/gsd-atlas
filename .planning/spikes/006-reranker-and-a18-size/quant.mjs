// Spike 006: effect of Matryoshka truncation and int8/binary storage on dense recall@10 (SDK slice), plus bytes per vector.
// usage: node quant.mjs <embedder-gguf> <dataDir> <outFile> <queryPrefix>   env: D_PREFIX
import fs from 'node:fs'; import path from 'node:path';
import { getLlama } from '../002b-runtime-llamacpp/node_modules/node-llama-cpp/dist/index.js';
import { loadDocs, resolveGold } from '../001-fts5-baseline-and-gold-queries/lib.mjs';
import { docText } from '../dense-lib.mjs';
const [gguf, dataDir, outFile, qPrefix] = process.argv.slice(2);
const G = path.join(import.meta.dirname, '../001-fts5-baseline-and-gold-queries');
const docs = loadDocs(dataDir); const pool = docs.filter((d) => d.slice === 'a');
const golds = resolveGold(docs, 'a', JSON.parse(fs.readFileSync(path.join(G, 'gold-a2.json'), 'utf8')));
const llama = await getLlama(); const ctx = await (await llama.loadModel({ modelPath: gguf })).createEmbeddingContext({ contextSize: 1024 });
const V = async (t) => Float32Array.from((await ctx.getEmbeddingFor(t)).vector);
const dv = []; for (const d of pool) dv.push(await V((process.env.D_PREFIX ?? '') + docText(d)));
const qv = []; for (const g of golds) qv.push(await V(qPrefix + g.q));
const trunc = (v, n) => { const o = v.slice(0, n); let s = 0; for (const x of o) s += x * x; s = Math.sqrt(s) || 1; return o.map((x) => x / s); };
const modes = {
  f32: { enc: (v) => v, sim: (a, b) => a.reduce((s, x, i) => s + x * b[i], 0), bytes: (n) => n * 4 },
  int8: { enc: (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127 * 3)))), sim: (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }, bytes: (n) => n },
  binary: { enc: (v) => Uint8Array.from(v, (x) => (x > 0 ? 1 : 0)), sim: (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] === b[i] ? 1 : 0; return s; }, bytes: (n) => Math.ceil(n / 8) },
};
const res = [];
for (const dim of [768, 512, 256, 128]) for (const [mode, m] of Object.entries(modes)) {
  const D = dv.map((v) => m.enc(trunc(v, dim))); let hits = 0;
  qv.forEach((q, qi) => {
    const qe = m.enc(trunc(q, dim));
    const ranked = pool.map((d, i) => [d.id, m.sim(qe, D[i])]).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 10).map((e) => e[0]);
    if (ranked.includes(golds[qi].gold)) hits++;
  });
  const bytes = m.bytes(dim); res.push({ dim, mode, r10: +(hits / golds.length).toFixed(3), bytesPerVector: bytes, mbPer100kSymbols: +(bytes * 100000 / 1e6).toFixed(1) });
}
console.table(res); fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
