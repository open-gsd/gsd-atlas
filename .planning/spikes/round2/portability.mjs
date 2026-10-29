// Metal vs ONNX comparison per model on the test halves. usage: node portability.mjs <a.json> <b.json>
import fs from 'node:fs';
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const ids = Object.keys(a.top10).filter((k) => a.top10[k].split === 'test' && b.top10[k]);
const rec = (r, set, arm) => { const ks = ids.filter((k) => k.startsWith(set + '|')); return +(ks.filter((k) => r.top10[k][arm].includes(k.slice(set.length + 1))).length / ks.length).toFixed(3); };
const overlap = (arm, set) => { const ks = ids.filter((k) => k.startsWith(set + '|')); return +(ks.reduce((s, k) => s + a.top10[k][arm].filter((x) => b.top10[k][arm].includes(x)).length / 10, 0) / ks.length).toFixed(3); };
const pr = (r) => r.primaryArm;
console.log(`${a.tag} vs ${b.tag}`, JSON.stringify({ V2: { dense: [rec(a, 'V2', 'D'), rec(b, 'V2', 'D')], primary: [rec(a, 'V2', 'primary'), rec(b, 'V2', 'primary')], overlapDense: overlap('D', 'V2'), overlapPrimary: overlap('primary', 'V2') }, I1: { dense: [rec(a, 'I1', 'D'), rec(b, 'I1', 'D')], overlapDense: overlap('D', 'I1') }, weights: [pr(a), pr(b)], docsPerSec: [a.docsPerSec, b.docsPerSec], addedP95: [a.latencyMs.addedP95, b.latencyMs.addedP95] }));
