// Round 5 (plan section 14.3): draws M5 targets (seed 51, reserve seed 52) and mechanical identifier queries I5 (seed 53). No search is run.
// usage: node sample-m5.mjs <sdk-data-dir> <round3-queries-dir> <round4-queries-dir> <out-dir>
import fs from 'node:fs'; import path from 'node:path';
const [dataDir, r3dir, r4dir, outDir] = process.argv.slice(2);
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
// exclusions: every V3 target (main, reserve, batch 2), every I3 gold id, every M4 target (main and reserve)
const used = new Set();
for (const f of ['v3-targets.json', 'v3-targets-batch2.json']) { const t = JSON.parse(fs.readFileSync(path.join(r3dir, f), 'utf8')); for (const a of t.authors.flat()) used.add(a[0]); for (const a of t.reserve ?? []) used.add(a[0]); }
for (const [id] of JSON.parse(fs.readFileSync(path.join(r3dir, 'gold-i3.json'), 'utf8'))) used.add(id);
{ const t = JSON.parse(fs.readFileSync(path.join(r4dir, 'm4-targets.json'), 'utf8')); for (const a of [...t.main, ...t.reserve]) used.add(a[0]); }
const NEED = { A: 60, B: 12, C: 60, D: 28 }, RES = { A: 8, B: 4, C: 8, D: 4 };
const r51 = mk(51), r52 = mk(52);
const main = [], reserve = []; const elig = {};
for (const st of Object.keys(NEED)) {
  const e = shuf(pool.filter((d) => base(d) && strata[st](d) && !used.has(d.id)), r51); elig[st] = e.length;
  main.push(...e.slice(0, NEED[st]).map((d) => ({ d, st })));
  reserve.push(...shuf(e.slice(NEED[st]), r52).slice(0, RES[st]).map((d) => ({ d, st })));
}
const CONTEXTS = [
  'You are building a new feature and need to find the right declaration to build it with.',
  'You are fixing a compile error, a deprecation warning or a crash and need the declaration that is the correct replacement or the right tool.',
  'You are porting or migrating code from another platform or from an older API and need the matching declaration in this SDK.',
  'You are reading unfamiliar code and checking what the framework offers for one specific need.',
];
const line = ({ d, st }, i) => `${i + 1}. [${d.id}]\n   framework: ${d.fw}${d.owner ? `   member of: ${d.owner}` : '   (top level)'}\n   name: ${d.name}   kind: ${d.kind}\n   declaration: ${d.sig.slice(0, 260)}\n   documentation: ${d.doc ? d.doc.slice(0, 350) : '(none)'}\n`;
const order = shuf([...main, ...reserve], mk(54)); const authors = [[], [], [], []]; order.forEach((x, i) => authors[i % 4].push(x));
authors.forEach((a, k) => fs.writeFileSync(path.join(outDir, `m5-author${k + 1}-targets.md`), `# M5 targets for author ${k + 1}\n\nTask context for every query below: ${CONTEXTS[k]}\n\n${a.map(line).join('\n')}`));
fs.writeFileSync(path.join(outDir, 'm5-targets.json'), JSON.stringify({ seed: 51, reserveSeed: 52, eligible: elig, main: main.map(({ d, st }) => [d.id, st]), reserve: reserve.map(({ d, st }) => [d.id, st]), authors: authors.map((a) => a.map(({ d, st }) => [d.id, st])) }, null, 1));
for (const [d] of [...main, ...reserve].map((x) => [x.d])) used.add(d.id);
// ---- I5: same construction as I3 (6 rules), seed 53, 120 queries, 60 objc + 60 swift
const camelParts = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').filter(Boolean);
const i5 = pool.filter((d) => nameCnt.get(d.name) === 1 && !used.has(d.id) && d.name.length >= 6 && /^[A-Za-z][A-Za-z0-9]*$/.test(d.name) && camelParts(d.name).length >= 2 && !d.fw.startsWith('_') && !d.unavailable);
const r53 = mk(53); const objc = shuf(i5.filter((d) => d.part === 'objc'), r53), sw = shuf(i5.filter((d) => d.part === 'swift'), r53);
const picks = []; for (let i = 0; i < 60; i++) picks.push(objc[i], sw[i]);
const RULES = ['exact', 'qualified', 'fragment', 'lowerjoined', 'misspelled', 'moduleMember'];
const swapInner = (n) => { const i = 1 + Math.floor(r53() * (n.length - 3)); return n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2); };
const out = picks.map((d, i) => {
  const rule = RULES[i % RULES.length], n = d.name, parts = camelParts(n), m = d.fw;
  const q = { exact: n, qualified: `${m}.${n}`, fragment: parts.slice(0, Math.max(2, Math.ceil(parts.length * 2 / 3))).join('').toLowerCase().slice(0, Math.max(5, Math.ceil(n.length * 2 / 3))), lowerjoined: n.toLowerCase(), misspelled: swapInner(n), moduleMember: `${m} ${n}` }[rule];
  return [d.id, q, rule];
});
fs.writeFileSync(path.join(outDir, 'gold-i5.json'), JSON.stringify(out, null, 1));
const byRule = {}; for (const [, , r] of out) byRule[r] = (byRule[r] ?? 0) + 1;
console.log(JSON.stringify({ poolSize: pool.length, eligible: elig, main: main.length, reserve: reserve.length, perAuthor: authors.map((a) => a.length), i5Eligible: i5.length, i5: out.length, byRule }));
