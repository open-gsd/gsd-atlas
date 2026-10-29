// Mechanical identifier-query set I1 (seed 32). Targets: unique (owner,name) in Pool B, disjoint from V2 targets and round 1 gold. No search is run.
// usage: node gen-i1.mjs <poolb-data-dir> <round1-gold-dir> <v2-targets.json> <out.json>
import fs from 'node:fs'; import path from 'node:path';
const [dataDir, goldDir, v2File, outFile] = process.argv.slice(2);
const { docs } = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs.json'), 'utf8'));
const pool = docs.filter((d) => d.slice === 'a');
const ownerOf = (d) => (d.part === 'tslib' ? d.id.split(':').slice(4).join(':').replace(/\.[^.]+$/, '') : '');
const key = (d) => `${ownerOf(d)}|${d.name}`;
const cnt = new Map(); for (const d of pool) cnt.set(key(d), (cnt.get(key(d)) ?? 0) + 1);
const v2 = JSON.parse(fs.readFileSync(v2File, 'utf8')); const excluded = new Set([...v2.owner, ...v2.agent]);
const used = new Set([...JSON.parse(fs.readFileSync(path.join(goldDir, 'gold-a.json'), 'utf8')), ...JSON.parse(fs.readFileSync(path.join(goldDir, 'gold-a2.json'), 'utf8'))].map((x) => x[0]));
const camelParts = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').filter(Boolean);
const elig = pool.filter((d) => cnt.get(key(d)) === 1 && !excluded.has(d.id) && !(d.part === 'node' && used.has(d.name)) && d.name.length >= 6 && /^[A-Za-z_$][\w$]*$/.test(d.name) && camelParts(d.name).length >= 2);
let s = 32 >>> 0; const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuf = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const node = shuf(elig.filter((d) => d.part === 'node')), ts = shuf(elig.filter((d) => d.part === 'tslib'));
const picks = []; for (let i = 0; i < 42; i++) { picks.push(node[i], ts[i]); } // 84 targets, half per part, alternating
const RULES = ['exact', 'qualified', 'fragment', 'lowerjoined', 'misspelled', 'moduleMember'];
const modOf = (d) => (d.part === 'tslib' ? (ownerOf(d) && ownerOf(d) !== d.name ? ownerOf(d) : d.qual.split('#')[0].replace(/^lib\./, '')) : d.qual.replace(/\.d$/, '').replace(/^.*\//, ''));
const swapInner = (n) => { const i = 1 + Math.floor(rnd() * (n.length - 3)); return n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2); };
const out = picks.map((d, i) => {
  const rule = RULES[i % RULES.length]; const n = d.name; const parts = camelParts(n); const m = modOf(d);
  const q = { exact: n, qualified: `${m}.${n}`, fragment: parts.slice(0, Math.max(2, Math.ceil(parts.length * 2 / 3))).join('').toLowerCase().slice(0, Math.max(5, Math.ceil(n.length * 2 / 3))), lowerjoined: n.toLowerCase(), misspelled: swapInner(n), moduleMember: `${m} ${n}` }[rule];
  return [d.id, q, rule];
});
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
const byRule = {}; for (const [, , r] of out) byRule[r] = (byRule[r] ?? 0) + 1;
console.log(JSON.stringify({ eligible: elig.length, queries: out.length, byRule, sample: out.slice(0, 8).map((x) => x[1]) }));
