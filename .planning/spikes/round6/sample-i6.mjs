// Round 6 (plan section 15.3): draws I6 mechanical identifier queries (seed 61), 40 per rule, 20 objc + 20 swift per rule. No search is run.
// usage: node sample-i6.mjs <sdk-data-dir> <round3-queries-dir> <round4-queries-dir> <round5-queries-dir> <out-dir>
import fs from 'node:fs'; import path from 'node:path';
const [dataDir, r3dir, r4dir, r5dir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const { docs } = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs.json'), 'utf8'));
const pool = docs.filter((d) => d.slice === 'a');
const nameCnt = new Map(); for (const d of pool) nameCnt.set(d.name, (nameCnt.get(d.name) ?? 0) + 1);
const mk = (seed) => { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const shuf = (a, rnd) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// exclusions: every V3 target, I3 gold id, M4 target, M5 target (main, reserve, authors), I5 gold id
const used = new Set();
for (const f of ['v3-targets.json', 'v3-targets-batch2.json']) { const t = JSON.parse(fs.readFileSync(path.join(r3dir, f), 'utf8')); for (const a of t.authors.flat()) used.add(a[0]); for (const a of t.reserve ?? []) used.add(a[0]); }
for (const [id] of JSON.parse(fs.readFileSync(path.join(r3dir, 'gold-i3.json'), 'utf8'))) used.add(id);
{ const t = JSON.parse(fs.readFileSync(path.join(r4dir, 'm4-targets.json'), 'utf8')); for (const a of [...t.main, ...t.reserve]) used.add(a[0]); }
{ const t = JSON.parse(fs.readFileSync(path.join(r5dir, 'm5-targets.json'), 'utf8')); for (const a of [...t.main, ...t.reserve]) used.add(a[0]); }
for (const [id] of JSON.parse(fs.readFileSync(path.join(r5dir, 'gold-i5.json'), 'utf8'))) used.add(id);
const camelParts = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').filter(Boolean);
const elig = pool.filter((d) => nameCnt.get(d.name) === 1 && !used.has(d.id) && d.name.length >= 6 && /^[A-Za-z][A-Za-z0-9]*$/.test(d.name) && camelParts(d.name).length >= 2 && !d.fw.startsWith('_') && !d.unavailable);
const r61 = mk(61); const objc = shuf(elig.filter((d) => d.part === 'objc'), r61), sw = shuf(elig.filter((d) => d.part === 'swift'), r61);
const RULES = ['exact', 'qualified', 'fragment', 'lowerjoined', 'misspelled', 'moduleMember'];
const swapInner = (n) => { const i = 1 + Math.floor(r61() * (n.length - 3)); return n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2); };
// part alternates with i; rule advances every two picks, so each rule gets 20 objc and 20 swift (the I3/I5 construction tied rule to part)
const out = []; for (let i = 0; i < 240; i++) {
  const d = (i % 2 === 0 ? objc : sw)[Math.floor(i / 2)], rule = RULES[Math.floor(i / 2) % 6], n = d.name, parts = camelParts(n), m = d.fw;
  const q = { exact: n, qualified: `${m}.${n}`, fragment: parts.slice(0, Math.max(2, Math.ceil(parts.length * 2 / 3))).join('').toLowerCase().slice(0, Math.max(5, Math.ceil(n.length * 2 / 3))), lowerjoined: n.toLowerCase(), misspelled: swapInner(n), moduleMember: `${m} ${n}` }[rule];
  out.push([d.id, q, rule]);
}
fs.writeFileSync(path.join(outDir, 'gold-i6.json'), JSON.stringify(out, null, 1));
const byRule = {}; for (const [, , r] of out) byRule[r] = (byRule[r] ?? 0) + 1;
console.log(JSON.stringify({ poolSize: pool.length, excluded: used.size, eligible: elig.length, objc: objc.length, swift: sw.length, i6: out.length, byRule }));
