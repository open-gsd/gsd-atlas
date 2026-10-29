// Round 4 Part D (plan section 13.4): adds symbol-graph doc comments to Swift pack records that have no prose.
// usage: node enrich-swift.mjs <sdk-data-dir> <symbolgraph-dir> <out-dir>
// Join key: module|owner.name, where module is the symbol-graph file prefix before '@', owner the path component before the name, name the last path component without its argument labels.
// The first doc comment per key wins. Only records with part 'swift' and an empty doc are changed. Doc text: lines joined, whitespace collapsed, at most 600 characters.
import fs from 'node:fs'; import path from 'node:path';
const [dataDir, sgDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs.json'), 'utf8'));
const prose = new Map(); let graphs = 0, symbols = 0, withDoc = 0;
for (const m of fs.readdirSync(sgDir, { withFileTypes: true })) {
  if (!m.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(sgDir, m.name))) {
    if (!f.endsWith('.symbols.json')) continue;
    const module = f.replace(/\.symbols\.json$/, '').split('@')[0]; graphs++;
    const g = JSON.parse(fs.readFileSync(path.join(sgDir, m.name, f), 'utf8'));
    for (const s of g.symbols) {
      symbols++; if (!s.docComment?.lines?.length) continue; withDoc++;
      const p = s.pathComponents; const name = p.at(-1).replace(/\(.*$/, ''); const owner = p.length > 1 ? p.at(-2) : '';
      const key = `${module}|${owner}.${name}`; if (prose.has(key)) continue;
      const text = s.docComment.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600); if (text) prose.set(key, text);
    }
  }
}
let enriched = 0, swiftEmpty = 0; const perModule = {};
for (const d of data.docs) {
  if (d.part !== 'swift' || d.doc) continue; swiftEmpty++;
  const t = prose.get(`${d.fw}|${d.owner}.${d.name}`); if (!t) continue;
  d.doc = t; d.enrichedFromSymbolGraph = true; enriched++; perModule[d.fw] = (perModule[d.fw] ?? 0) + 1;
}
fs.writeFileSync(path.join(outDir, 'docs.json'), JSON.stringify(data));
const summary = { graphs, symbols, withDoc, distinctKeys: prose.size, swiftRecordsWithoutProse: swiftEmpty, enriched, share: +(enriched / swiftEmpty).toFixed(3), topModules: Object.entries(perModule).sort((a, b) => b[1] - a[1]).slice(0, 15) };
fs.writeFileSync(path.join(outDir, 'enrich-summary.json'), JSON.stringify(summary, null, 1)); console.log(JSON.stringify(summary));
