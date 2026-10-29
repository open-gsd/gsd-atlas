// One-time explicit model fetch into the local cache (network allowed only here). usage: node prefetch.mjs <model> <dtype>
import { pipeline, env } from '@huggingface/transformers';
env.cacheDir = process.env.SPIKE_MODEL_CACHE;
await pipeline('feature-extraction', process.argv[2], { dtype: process.argv[3] });
console.log('cached', process.argv[2], process.argv[3]);
