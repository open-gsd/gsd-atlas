// Round 4 EXPLORATORY post-hoc arms (not pre-registered; reported separately from the conditions).
// usage: node posthoc4.mjs --data <dir> --base lists-base.json --out posthoc.json
// X1 = unselected registered candidate R3 (exact-name hit -> lexical, else dense) evaluated against P1/P3 for transparency.
// X2 = hybrid scoping: lexical index over the FULL pool, dense lane over Pool-lite only, primary router R4.
import fs from 'node:fs'; import path from 'node:path';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const { docs } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8')); const byId = new Map(docs.map((d) => [d.id, d]));
const base = JSON.parse(fs.readFileSync(A.base, 'utf8')); const rows = base.rows;
const hit = (l, g, k = 10) => { const p = l.indexOf(g); return p >= 0 && p < k ? 1 : 0; };
const wrrf = (lex, den, w, k = 60) => { const m = new Map(); lex.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (k + i + 1))); den.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + w / (k + i + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 50).map((e) => e[0]); };
const r2Hit = (q, lex) => { const top = byId.get(lex[0]); if (!top) return false; const x = q.trim().toLowerCase(); return x === top.name.toLowerCase() || x === `${top.owner}.${top.name}`.toLowerCase() || x === `${top.fw}.${top.name}`.toLowerCase(); };
const nameTok = (q, lex) => { const top = byId.get(lex[0]); if (!top) return false; const bits = new Set([top.name.toLowerCase(), ...top.nameSplit.toLowerCase().split(/\s+/)]); return q.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 4 && bits.has(w)); };
const R3 = (r, lex, den) => (r2Hit(r.q, lex) ? lex : den); const R4 = (r, lex, den) => (r2Hit(r.q, lex) ? lex : nameTok(r.q, lex) ? wrrf(lex, den, 3) : den);
const arms = { D: (r) => r.den, L: (r) => r.lexF2, R3: (r) => R3(r, r.lexF2, r.den), R4: (r) => R4(r, r.lexF2, r.den), X2_R4_hybridLite: (r) => R4(r, r.lexF2, r.denLite), X2_R3_hybridLite: (r) => R3(r, r.lexF2, r.denLite), D_lite: (r) => r.denLite };
const mulberry = (seed) => { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const boot = (d) => { const n = d.length; const r = mulberry(42); const m = []; for (let i = 0; i < 10000; i++) { let s = 0; for (let j = 0; j < n; j++) s += d[Math.floor(r() * n)]; m.push(s / n); } m.sort((x, y) => x - y); return { n, mean: +(d.reduce((x, y) => x + y, 0) / n).toFixed(4), p5: +m[500].toFixed(4) }; };
const out = { table: {}, vs: {} };
for (const set of ['V3', 'I3', 'M4']) { const rs = rows.filter((r) => r.set === set && r.split === 'test'); out.table[set] = { n: rs.length, ...Object.fromEntries(Object.entries(arms).map(([k, f]) => [k, +(rs.reduce((s, r) => s + hit(f(r), r.id), 0) / rs.length).toFixed(3)])) };
  for (const [a, b] of [['R3', 'D'], ['R3', 'R4'], ['X2_R4_hybridLite', 'R4'], ['X2_R3_hybridLite', 'R3']]) (out.vs[set] ??= {})[`${a}_vs_${b}`] = boot(rs.map((r) => hit(arms[a](r), r.id) - hit(arms[b](r), r.id))); }
const vt = rows.filter((r) => r.set === 'V3' && r.split === 'test'); out.R3_vs_L_V3 = boot(vt.map((r) => hit(arms.R3(r), r.id) - hit(arms.L(r), r.id)));
const tuneN = (set) => rows.filter((r) => r.set === set && r.split === 'tuning').length; out.tuningSizes = { V3: tuneN('V3'), I3: tuneN('I3'), M4: tuneN('M4') };
fs.writeFileSync(A.out, JSON.stringify(out, null, 1)); console.log(JSON.stringify(out));
