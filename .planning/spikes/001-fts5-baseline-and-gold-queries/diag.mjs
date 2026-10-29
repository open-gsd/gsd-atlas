import fs from 'node:fs'; import path from 'node:path';
import { loadDocs, resolveGold, buildFts, tokens } from './lib.mjs';
const docs = loadDocs(process.argv[2]); const J = (f) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, f), 'utf8'));
const byId = new Map(docs.map((d) => [d.id, d]));
for (const [k, g, sl] of [['a', resolveGold(docs, 'a', J('gold-a.json')), 'a'], ['b', resolveGold(docs, 'b', J('gold-b.json')), 'b'], ['c2', resolveGold(docs, 'c', J('gold-c2.json')), 'c']]) {
  const fts = buildFts(docs, sl); let low = 0; const misses = [];
  for (const x of g) {
    const d = byId.get(x.gold); const text = `${d.name} ${d.nameSplit} ${d.doc} ${d.sig}`.toLowerCase();
    const qt = tokens(x.q); const share = qt.filter((t) => text.includes(t)).length / qt.length;
    if (share <= 0.5) low++;
    const pos = fts.search(x.q, 50).indexOf(x.gold); if (pos < 0 || pos >= 10) misses.push(`${x.name} pos=${pos} share=${share.toFixed(2)}`);
  }
  console.log(k, 'queries with <=50% of content tokens present in target text:', low, '/', g.length, '| misses@10:', misses.join('; ') || 'none');
}
