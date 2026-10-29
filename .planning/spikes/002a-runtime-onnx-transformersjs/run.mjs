import { pipeline, env } from '@huggingface/transformers';
import { evaluate } from '../dense-lib.mjs';
const [model, dataDir, outFile, qPrefix = '', dtype = 'fp32'] = process.argv.slice(2);
env.cacheDir = process.env.SPIKE_MODEL_CACHE;
const t0 = performance.now();
const ex = await pipeline('feature-extraction', model, { dtype });
console.log('model load ms', Math.round(performance.now() - t0));
const embedder = { name: `${model}@${dtype}`, qPrefix, dPrefix: '', async embed(texts) { const out = []; for (let i = 0; i < texts.length; i += 16) { const r = await ex(texts.slice(i, i + 16), { pooling: 'mean', normalize: true }); for (const row of r.tolist()) out.push(Float32Array.from(row)); } return out; } };
await evaluate(embedder, dataDir, outFile);
