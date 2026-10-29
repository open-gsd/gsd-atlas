// Round 4 (plan section 13.3): draws M4 targets (seed 47; reserve seed 48). No search is run.
// usage: node sample-m4.mjs <sdk-data-dir> <round3-queries-dir> <out-dir>
import fs from 'node:fs'; import path from 'node:path';
const [dataDir, r3dir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const { docs } = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs.json'), 'utf8'));
const pool = docs.filter((d) => d.slice === 'a');
const key = (d) => `${d.fw}|${d.owner}|${d.name}`;
const keyCnt = new Map(), nameCnt = new Map();
for (const d of pool) { keyCnt.set(key(d), (keyCnt.get(key(d)) ?? 0) + 1); nameCnt.set(d.name, (nameCnt.get(d.name) ?? 0) + 1); }
const BOILER = new Set(['init', 'hashValue', 'description', 'debugDescription', 'hash', 'isEqual', 'copy', 'dealloc', 'self', 'body', 'id', 'rawValue', 'count', 'name', 'value', 'new', 'delegate']);
const SWIFT_KINDS = new Set(['struct', 'class', 'enum', 'protocol', 'func', 'var', 'typealias', 'actor', 'macro']);
const base = (d) => keyCnt.get(key(d)) === 1 && nameCnt.get(d.name) <= 3 && d.name.length >= 4 && !BOILER.has(d.name) && !d.unavailable && !d.fw.startsWith('_') && !d.name.startsWith('_') && /^[A-Za-z][\w:]*$/.test(d.name);
const is27 = (d) => d.introduced && d.introduced.startsWith('27');
const strata = {
  A: (d) => d.part === 'objc' && d.doc.length >= 60 && !is27(d),
  B: (d) => d.part === 'objc' && d.doc.length >= 40 && is27(d),
  C: (d) => d.part === 'swift' && SWIFT_KINDS.has(d.kind) && is27(d) && d.owner !== '' || (d.part === 'swift' && SWIFT_KINDS.has(d.kind) && is27(d) && ['struct', 'class', 'enum', 'protocol', 'typealias', 'actor'].includes(d.kind)),
  D: (d) => d.part === 'swift' && SWIFT_KINDS.has(d.kind) && d.introduced && !is27(d),
};
const mk = (seed) => { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const shuf = (a, rnd) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// exclusions: every V3 target (main, reserve, batch 2) and every I3 gold id
const used = new Set();
for (const f of ['v3-targets.json', 'v3-targets-batch2.json']) { const t = JSON.parse(fs.readFileSync(path.join(r3dir, f), 'utf8')); for (const a of t.authors.flat()) used.add(a[0]); for (const a of t.reserve ?? []) used.add(a[0]); }
for (const [id] of JSON.parse(fs.readFileSync(path.join(r3dir, 'gold-i3.json'), 'utf8'))) used.add(id);
const NEED = { A: 30, B: 15, C: 30, D: 15 }, RESERVE = 6 * 3 / 4; // 18 reserve in total, spread over strata
const r47 = mk(47), r48 = mk(48);
const main = [], reserve = []; const elig = {};
for (const st of Object.keys(NEED)) {
  const e = shuf(pool.filter((d) => base(d) && strata[st](d) && !used.has(d.id)), r47); elig[st] = e.length;
  main.push(...e.slice(0, NEED[st]).map((d) => ({ d, st })));
  reserve.push(...shuf(e.slice(NEED[st]), r48).slice(0, st === 'A' || st === 'C' ? 6 : 3).map((d) => ({ d, st })));
}
const line = ({ d, st }, i) => `${i + 1}. [${d.id}]\n   framework: ${d.fw}${d.owner ? `   member of: ${d.owner}` : '   (top level)'}\n   name: ${d.name}   kind: ${d.kind}\n   declaration: ${d.sig.slice(0, 260)}\n   documentation: ${d.doc ? d.doc.slice(0, 350) : '(none)'}\n`;
// three authors: interleaved shares of main + reserve (reserve is authored too, used only if the checker leaves fewer than 60)
const order = shuf([...main, ...reserve], mk(49)); const authors = [[], [], []]; order.forEach((x, i) => authors[i % 3].push(x));
authors.forEach((a, k) => fs.writeFileSync(path.join(outDir, `m4-author${k + 1}-targets.md`), `# M4 targets for author ${k + 1}\n\n${a.map(line).join('\n')}`));
fs.writeFileSync(path.join(outDir, 'm4-targets.json'), JSON.stringify({ seed: 47, reserveSeed: 48, eligible: elig, main: main.map(({ d, st }) => [d.id, st]), reserve: reserve.map(({ d, st }) => [d.id, st]), authors: authors.map((a) => a.map(({ d, st }) => [d.id, st])) }, null, 1));
console.log(JSON.stringify({ eligible: elig, main: main.length, reserve: reserve.length, perAuthor: authors.map((a) => a.length) }));
