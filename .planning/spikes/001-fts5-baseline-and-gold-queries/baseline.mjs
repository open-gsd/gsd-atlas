import fs from 'node:fs';
import path from 'node:path';
import { loadDocs, resolveGold, buildFts, metrics } from './lib.mjs';
import { makeC1 } from './gold-c1.mjs';
const dataDir = process.argv[2];
const here = import.meta.dirname;
const docs = loadDocs(dataDir);
const J = (f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'));
const slices = {
  a: resolveGold(docs, 'a', J('gold-a.json')),
  b: resolveGold(docs, 'b', J('gold-b.json')),
  c1: makeC1(dataDir),
  c2: resolveGold(docs, 'c', J('gold-c2.json')),
};
const out = {};
for (const [k, golds] of Object.entries(slices)) {
  const fts = buildFts(docs, k === 'c1' || k === 'c2' ? 'c' : k);
  const t0 = performance.now();
  const m = metrics(golds, (g) => fts.search(g.q, 50));
  const ms = (performance.now() - t0) / golds.length;
  out[k] = { poolSize: docs.filter((d) => d.slice === (k[0] === 'c' ? 'c' : k)).length, ...m, msPerQuery: ms };
  delete out[k].rows;
  console.log(k, JSON.stringify({ n: m.all.n, r5: +m.all.r5.toFixed(3), r10: +m.all.r10.toFixed(3), mrr: +m.all.mrr.toFixed(3), overlapN: m.overlap.n, overlapR10: +m.overlap.r10.toFixed(3), noOverlapN: m.noOverlap.n, noOverlapR10: +m.noOverlap.r10.toFixed(3), msPerQuery: +ms.toFixed(2) }));
}
fs.writeFileSync(path.join(here, 'baseline-results.json'), JSON.stringify({ date: '2026-10-28', corpus: 'gsd-core@10ac3a7a947903ba50f538a907af036744d759d5', out }, null, 1));
