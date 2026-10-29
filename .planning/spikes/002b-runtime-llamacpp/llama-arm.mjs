// Runtime arm 002b: node-llama-cpp (llama.cpp, Metal on this Mac) installed with --ignore-scripts, GGUF from a local cache.
// usage: node llama-arm.mjs <gguf-path> <dataDir> <outFile> [queryPrefix]   env: D_PREFIX
import { getLlama } from 'node-llama-cpp';
import { evaluate } from '../dense-lib.mjs';
const [gguf, dataDir, outFile, qPrefix = ''] = process.argv.slice(2);
const t0 = performance.now();
const llama = await getLlama();
const model = await llama.loadModel({ modelPath: gguf });
const ctx = await model.createEmbeddingContext({ contextSize: 1024 });
console.log('gpu', llama.gpu, 'load ms', Math.round(performance.now() - t0));
const embedder = {
  name: `${gguf.split('/').pop()}@llama.cpp-${llama.gpu}`, qPrefix, dPrefix: process.env.D_PREFIX ?? '',
  async embed(texts) {
    const out = [];
    for (const t of texts) { const e = await ctx.getEmbeddingFor(t); out.push(Float32Array.from(e.vector)); }
    return out;
  },
};
await evaluate(embedder, dataDir, outFile);
