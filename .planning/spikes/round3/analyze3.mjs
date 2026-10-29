// Round 3 post-hoc breakdown from saved result files (top-10 lists). Needed because run-round3.mjs read stratum labels from the first target file only
// (batch 2 targets had no label, so the per-stratum block inside the result JSON covers 83 of 206 test queries). Overall numbers are unaffected.
// usage: node analyze3.mjs <sdk-dir> <out.json> <result.json> [more.json ...]
import fs from 'node:fs'; import path from 'node:path';
const [dataDir, outFile, ...files] = process.argv.slice(2);
const { docs } = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs.json'), 'utf8')); const by = new Map(docs.map((d) => [d.id, d]));
const t1 = JSON.parse(fs.readFileSync('queries/v3-targets.json', 'utf8')), t2 = JSON.parse(fs.readFileSync('queries/v3-targets-batch2.json', 'utf8'));
const st = new Map([...t1.authors.flat(), ...t1.reserve, ...t2.authors.flat()]);
const mulberry = (seed) => { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const boot = (d) => { const n = d.length; if (!n) return null; const r = mulberry(42); const m = []; for (let i = 0; i < 10000; i++) { let s = 0; for (let j = 0; j < n; j++) s += d[Math.floor(r() * n)]; m.push(s / n); } m.sort((a, b) => a - b); return { n, mean: +(d.reduce((a, b) => a + b, 0) / n).toFixed(3), p5: +m[500].toFixed(3), p95: +m[9500].toFixed(3) }; };
const out = {};
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8')); const rows = [];
  for (const [k, v] of Object.entries(r.top10)) { if (!k.startsWith('V3|') || v.split !== 'test') continue; const id = k.slice(3); const h = (l) => (l.includes(id) ? 1 : 0); rows.push({ id, st: st.get(id), part: by.get(id).part, L: h(v.L), D: h(v.D), P: h(v.primary) }); }
  const sum = (rs) => ({ n: rs.length, L: +(rs.reduce((s, x) => s + x.L, 0) / rs.length).toFixed(3), D: +(rs.reduce((s, x) => s + x.D, 0) / rs.length).toFixed(3), primary: +(rs.reduce((s, x) => s + x.P, 0) / rs.length).toFixed(3), primary_vs_L: boot(rs.map((x) => x.P - x.L)), D_vs_L: boot(rs.map((x) => x.D - x.L)), primary_vs_D: boot(rs.map((x) => x.P - x.D)) });
  const o = { all: sum(rows) }; for (const s of ['A', 'B', 'C', 'D']) o[s] = sum(rows.filter((x) => x.st === s)); o.BplusC = sum(rows.filter((x) => x.st === 'B' || x.st === 'C')); o.objc = sum(rows.filter((x) => x.part === 'objc')); o.swift = sum(rows.filter((x) => x.part === 'swift'));
  out[path.basename(f)] = o;
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
for (const [f, o] of Object.entries(out)) { console.log(f); console.table(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.n, L: v.L, D: v.D, primary: v.primary, 'P-L mean': v.primary_vs_L.mean, 'P-L p5': v.primary_vs_L.p5, 'D-L mean': v.D_vs_L.mean, 'P-D mean': v.primary_vs_D.mean, 'P-D p5': v.primary_vs_D.p5 }]))); }
