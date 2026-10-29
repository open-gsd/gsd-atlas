// Extracts retrieval documents for the three slices. Deterministic, no network.
// usage: node extract.mjs <gsd-core-pin-dir> <out-dir>
import fs from 'node:fs';
import path from 'node:path';

const [coreDir, outDir] = process.argv.slice(2);
const repoRoot = path.resolve(import.meta.dirname, '../../..');
fs.mkdirSync(outDir, { recursive: true });

const splitIdent = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.$]+/g, ' ').toLowerCase().trim();

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'coverage'].includes(e.name)) continue;
      yield* walk(p);
    } else yield p;
  }
}

function leadingComment(lines, i) {
  let j = i - 1;
  if (j >= 0 && lines[j].trim().endsWith('*/')) {
    let k = j; while (k >= 0 && !lines[k].includes('/*') && j - k < 120) k--;
    const block = lines.slice(Math.max(k, 0), j + 1).map((l) => l.trim().replace(/^\/\*+|\*+\/$|^\*+\s?/g, '').trim());
    const desc = []; for (const l of block) { if (l.startsWith('```') ) break; if (l) desc.push(l); }
    return desc.join(' ');
  }
  const out = [];
  while (j >= 0 && out.length < 14) {
    const t = lines[j].trim();
    if (t.startsWith('//')) { out.unshift(t.replace(/^\/\/\s?/, '').trim()); j--; } else break;
  }
  return out.filter(Boolean).join(' ');
}

const RES = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/,
];

// slice c: gsd-core code symbols
const code = [];
for (const f of walk(coreDir)) {
  const rel = path.relative(coreDir, f);
  if (!/\.(cjs|js|mjs|ts)$/.test(f) || /(^|\/)(tests?|__tests__)\/|\.test\.|\.min\./.test(rel)) continue;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((ln, i) => {
    for (const re of RES) {
      const m = re.exec(ln);
      if (m) { code.push({ id: `c:${rel}:${i + 1}:${m[1]}`, slice: 'c', name: m[1], qual: rel, doc: leadingComment(lines, i), sig: ln.trim().slice(0, 200) }); break; }
    }
  });
}
// slice b: ADR sections of this repo
const adr = [];
const adrDir = path.join(repoRoot, 'docs/adr');
for (const f of fs.readdirSync(adrDir).filter((n) => n.endsWith('.md')).sort()) {
  const text = fs.readFileSync(path.join(adrDir, f), 'utf8');
  const parts = text.split(/^(?=#{2,3} )/m);
  parts.forEach((p, k) => {
    const h = /^#{1,3} (.+)/.exec(p);
    const body = p.replace(/^#{1,3} .+\n/, '').trim();
    if (body.length < 120) return;
    adr.push({ id: `b:${f}:${k}`, slice: 'b', name: `${f.replace(/\.md$/, '')} ${h ? h[1] : 'intro'}`, qual: f, doc: body.slice(0, 1500), sig: '' });
  });
}
// slice a: Node SDK declarations with JSDoc (@types/node, installed version)
const sdk = [];
const tdir = path.join(repoRoot, 'node_modules/@types/node');
const tver = JSON.parse(fs.readFileSync(path.join(tdir, 'package.json'), 'utf8')).version;
for (const f of walk(tdir)) {
  if (!f.endsWith('.d.ts')) continue;
  const rel = path.relative(tdir, f);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((ln, i) => {
    const m = /^\s*(?:export\s+)?(?:declare\s+)?(?:function|class|interface|enum)\s+([A-Za-z_$][\w$]*)|^\s{4}(?:function\s+)?([a-z][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\(/.exec(ln);
    const name = m && (m[1] || m[2]);
    if (!name) return;
    const doc = leadingComment(lines, i);
    if (doc.length < 40) return;
    sdk.push({ id: `a:${rel}:${i + 1}:${name}`, slice: 'a', name, qual: rel.replace(/\.d\.ts$/, ''), doc, sig: ln.trim().slice(0, 200) });
  });
}
for (const r of [...code, ...adr, ...sdk]) r.nameSplit = splitIdent(r.name);
fs.writeFileSync(path.join(outDir, 'docs.json'), JSON.stringify({ meta: { typesNode: tver, counts: { code: code.length, adr: adr.length, sdk: sdk.length } }, docs: [...code, ...adr, ...sdk] }));
console.log(JSON.stringify({ typesNode: tver, code: code.length, codeWithDoc: code.filter((d) => d.doc.length >= 40).length, adr: adr.length, sdk: sdk.length }));
