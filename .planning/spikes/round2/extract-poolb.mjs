// Pool B extraction: Pool A (@types/node declarations with JSDoc, as in round 1) plus declarations with a descriptive comment
// from the installed typescript package's lib.*.d.ts files. Output replaces slice 'a' in a copy of docs.json.
// usage: node extract-poolb.mjs <round1-data-dir> <out-data-dir>
import fs from 'node:fs'; import path from 'node:path';
const [inDir, outDir] = process.argv.slice(2);
const repoRoot = path.resolve(import.meta.dirname, '../../..');
fs.mkdirSync(outDir, { recursive: true });
const splitIdent = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.$]+/g, ' ').toLowerCase().trim();
function leadingComment(lines, i) {
  let j = i - 1;
  if (j >= 0 && lines[j].trim().endsWith('*/')) {
    let k = j; while (k >= 0 && !lines[k].includes('/*') && j - k < 120) k--;
    const block = lines.slice(Math.max(k, 0), j + 1).map((l) => l.trim().replace(/^\/\*+|\*+\/$|^\*+\s?/g, '').trim());
    const desc = []; for (const l of block) { if (l.startsWith('```') || l.startsWith('@')) break; if (l) desc.push(l); }
    return desc.join(' ');
  }
  return '';
}
const tsDir = path.join(repoRoot, 'node_modules/typescript/lib');
const tsVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules/typescript/package.json'), 'utf8')).version;
const extra = [];
for (const f of fs.readdirSync(tsDir).filter((n) => /^lib\..*\.d\.ts$/.test(n)).sort()) {
  const lines = fs.readFileSync(path.join(tsDir, f), 'utf8').split('\n');
  let owner = '';
  lines.forEach((ln, i) => {
    const top = /^(?:declare\s+)?(?:interface|class|namespace|enum)\s+([A-Za-z_$][\w$]*)/.exec(ln);
    if (top) owner = top[1];
    const m = /^(?:declare\s+)?(?:function|const|var|class|interface|enum)\s+([A-Za-z_$][\w$]*)|^\s{4}(?:readonly\s+)?(?:\[Symbol\.)?([A-Za-z_$][\w$]*)\]?\s*[?(<:]/.exec(ln);
    const name = m && (m[1] || m[2]); if (!name) return;
    const doc = leadingComment(lines, i);
    if (doc.length < 40) return;
    extra.push({ id: `a:tslib:${f}:${i + 1}:${owner ? owner + '.' : ''}${name}`, slice: 'a', part: 'tslib', name, qual: `${f.replace(/\.d\.ts$/, '')}#${owner}`, doc, sig: ln.trim().slice(0, 200), nameSplit: splitIdent(name) });
  });
}
const base = JSON.parse(fs.readFileSync(path.join(inDir, 'docs.json'), 'utf8'));
const docs = base.docs.map((d) => (d.slice === 'a' ? { ...d, part: 'node' } : d)).concat(extra);
const counts = { node: docs.filter((d) => d.part === 'node').length, tslib: extra.length };
const ids = new Set(); for (const d of docs) { if (ids.has(d.id)) throw new Error(`duplicate id ${d.id}`); ids.add(d.id); }
const byFile = {}; for (const d of extra) byFile[d.qual.split('#')[0]] = (byFile[d.qual.split('#')[0]] ?? 0) + 1;
fs.writeFileSync(path.join(outDir, 'docs.json'), JSON.stringify({ meta: { typesNode: base.meta.typesNode, typescript: tsVersion, counts }, docs }));
console.log(JSON.stringify({ typesNode: base.meta.typesNode, typescript: tsVersion, poolA_node: counts.node, tslibAdded: counts.tslib, poolB_total: counts.node + counts.tslib, topFiles: Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 6) }));
