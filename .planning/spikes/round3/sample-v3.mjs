// Round 3 (plan section 12): draws V3 targets (seed 41, reserve seed 43) and mechanical identifier queries I3 (seed 42). No search is run.
// usage: node sample-v3.mjs <sdk-data-dir> <out-dir>
import fs from 'node:fs'; import path from 'node:path';
const [dataDir, outDir] = process.argv.slice(2);
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
const NEED = { A: 70, B: 40, C: 60, D: 30 }, RESERVE = 10;
const rnd41 = mk(41), rnd43 = mk(43);
const main = [], reserve = []; const elig = {};
for (const st of Object.keys(NEED)) {
  const e = shuf(pool.filter((d) => base(d) && strata[st](d)), rnd41); elig[st] = e.length;
  main.push(...e.slice(0, NEED[st]).map((d) => ({ d, st })));
  reserve.push(...shuf(e.slice(NEED[st]), rnd43).slice(0, RESERVE).map((d) => ({ d, st })));
}
const line = ({ d, st }, i) => `${i + 1}. [${d.id}]\n   framework: ${d.fw}${d.owner ? `   member of: ${d.owner}` : '   (top level)'}\n   name: ${d.name}   kind: ${d.kind}\n   declaration: ${d.sig.slice(0, 260)}\n   documentation: ${d.doc ? d.doc.slice(0, 350) : '(none)'}\n`;
// three authors get an interleaved, stratum-balanced share of the main targets
const order = shuf(main, mk(44)); const authors = [[], [], []]; order.forEach((x, i) => authors[i % 3].push(x));
authors.forEach((a, k) => fs.writeFileSync(path.join(outDir, `author${k + 1}-targets.md`), `# V3 targets for author ${k + 1}\n\n${a.map(line).join('\n')}`));
fs.writeFileSync(path.join(outDir, 'reserve-targets.md'), `# V3 reserve targets\n\n${shuf(reserve, mk(45)).map(line).join('\n')}`);
fs.writeFileSync(path.join(outDir, 'v3-targets.json'), JSON.stringify({ seed: 41, reserveSeed: 43, eligible: elig, authors: authors.map((a) => a.map(({ d, st }) => [d.id, st])), reserve: reserve.map(({ d, st }) => [d.id, st]) }, null, 1));
// ---- I3
const used = new Set([...main, ...reserve].map((x) => x.d.id));
const camelParts = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').filter(Boolean);
const i3 = pool.filter((d) => nameCnt.get(d.name) === 1 && !used.has(d.id) && d.name.length >= 6 && /^[A-Za-z][A-Za-z0-9]*$/.test(d.name) && camelParts(d.name).length >= 2 && !d.fw.startsWith('_') && !d.unavailable);
const r42 = mk(42); const objc = shuf(i3.filter((d) => d.part === 'objc'), r42), sw = shuf(i3.filter((d) => d.part === 'swift'), r42);
const picks = []; for (let i = 0; i < 45; i++) picks.push(objc[i], sw[i]);
const RULES = ['exact', 'qualified', 'fragment', 'lowerjoined', 'misspelled', 'moduleMember'];
const swapInner = (n) => { const i = 1 + Math.floor(r42() * (n.length - 3)); return n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2); };
const out = picks.map((d, i) => {
  const rule = RULES[i % RULES.length], n = d.name, parts = camelParts(n), m = d.fw;
  const q = { exact: n, qualified: `${m}.${n}`, fragment: parts.slice(0, Math.max(2, Math.ceil(parts.length * 2 / 3))).join('').toLowerCase().slice(0, Math.max(5, Math.ceil(n.length * 2 / 3))), lowerjoined: n.toLowerCase(), misspelled: swapInner(n), moduleMember: `${m} ${n}` }[rule];
  return [d.id, q, rule];
});
fs.writeFileSync(path.join(outDir, 'gold-i3.json'), JSON.stringify(out, null, 1));
const byRule = {}; for (const [, , r] of out) byRule[r] = (byRule[r] ?? 0) + 1;
console.log(JSON.stringify({ poolSize: pool.length, eligible: elig, main: main.length, reserve: reserve.length, perAuthor: authors.map((a) => a.length), i3Eligible: i3.length, i3: out.length, byRule }));
// ---- amendment A2 (EXTRA=1): second draw, seed 46, excluding every main and reserve target; reserve targets are authored in this round too.
if (process.env.EXTRA) {
  const NEED2 = { A: 60, B: 30, C: 60, D: 30 }; const r46 = mk(46); const extra = [];
  for (const st of Object.keys(NEED2)) { const e = shuf(pool.filter((d) => base(d) && strata[st](d) && !used.has(d.id)), r46); extra.push(...e.slice(0, NEED2[st]).map((d) => ({ d, st }))); }
  const allNew = shuf([...reserve, ...extra], mk(47)); const au = [[], [], []]; allNew.forEach((x, i) => au[i % 3].push(x));
  au.forEach((a, k) => fs.writeFileSync(path.join(outDir, `batch2-author${k + 1}-targets.md`), `# V3 batch 2 targets for author ${k + 1}\n\n${a.map(line).join('\n')}`));
  fs.writeFileSync(path.join(outDir, 'v3-targets-batch2.json'), JSON.stringify({ seed: 46, authors: au.map((a) => a.map(({ d, st }) => [d.id, st])) }, null, 1));
  console.log(JSON.stringify({ batch2: allNew.length, perAuthor: au.map((a) => a.length) }));
}
