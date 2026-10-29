// Runtime arm 002c: MLX helper in the spike-local venv, called as a child process by the Node harness.
// usage: node mlx-arm.mjs <hf-repo> <dataDir> <outFile> <scratchDir> [queryPrefix]   env: D_PREFIX, HF_HOME
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { evaluate } from '../dense-lib.mjs';
const [repo, dataDir, outFile, scratch, qPrefix = ''] = process.argv.slice(2);
const py = path.join(import.meta.dirname, '../.venv-mlx/bin/python');
const helper = path.join(import.meta.dirname, 'mlx_embed.py');
let calls = 0;
const embedder = {
  name: `${repo}@mlx`, qPrefix, dPrefix: process.env.D_PREFIX ?? '',
  async embed(texts) {
    const inF = path.join(scratch, `mlx-in-${calls}.json`); const outF = path.join(scratch, `mlx-out-${calls++}.json`);
    fs.writeFileSync(inF, JSON.stringify(texts));
    const t0 = performance.now();
    const r = spawnSync(py, [helper, repo, inF, outF], { env: process.env, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`mlx helper failed: ${r.stderr.slice(-600)}`);
    const j = JSON.parse(fs.readFileSync(outF, 'utf8'));
    console.log(`mlx call: ${texts.length} texts, load ${j.load_s.toFixed(1)} s, total ${Math.round(performance.now() - t0)} ms`);
    return j.vectors.map((v) => Float32Array.from(v));
  },
};
await evaluate(embedder, dataDir, outFile);
