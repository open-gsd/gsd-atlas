// Runtime arm 002a: ONNX Runtime through transformers.js, install scripts blocked, models from a local cache.
// usage: node onnx-arm.mjs <model> <dataDir> <outFile> [queryPrefix] [dtype]   env: D_PREFIX (document prefix), SPIKE_MODEL_CACHE, POOLING
import { pipeline, env } from '@huggingface/transformers';
import { evaluate } from '../dense-lib.mjs';
const [model, dataDir, outFile, qPrefix = '', dtype = 'fp32'] = process.argv.slice(2);
env.cacheDir = process.env.SPIKE_MODEL_CACHE;
const pooling = process.env.POOLING ?? 'mean';
const t0 = performance.now();
const ex = await pipeline('feature-extraction', model, { dtype });
console.log('model load ms', Math.round(performance.now() - t0));
const embedder = {
  name: `${model}@${dtype}`,
  qPrefix,
  dPrefix: process.env.D_PREFIX ?? '',
  async embed(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += 16) {
      const r = await ex(texts.slice(i, i + 16), { pooling, normalize: true });
      for (const row of r.tolist()) out.push(Float32Array.from(row));
    }
    return out;
  },
};
await evaluate(embedder, dataDir, outFile);
