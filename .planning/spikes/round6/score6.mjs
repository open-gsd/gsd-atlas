// Round 6 scoring (plan section 15). usage: node score6.mjs --data <dir> --r5 round5 lists-eg1.json --i6 lists-i6.json --lat latency.json[,latency2.json,...] --out result.json
import fs from 'node:fs'; import path from 'node:path';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const { docs } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8')); const byId = new Map(docs.map((d) => [d.id, d]));
const rows = [...JSON.parse(fs.readFileSync(A.r5, 'utf8')).rows.filter((r) => r.split === 'test'), ...JSON.parse(fs.readFileSync(A.i6, 'utf8')).rows];
const lats = A.lat.split(',').map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))); const lat = lats[0];
const nolex = new Map(lat.rows.map((r) => [`${r.set}|${r.id}`, r]));
const hit = (l, g, k = 10) => { const p = l.indexOf(g); return p >= 0 && p < k ? 1 : 0; };
const wrrf = (lex, den, w, k = 60) => { const m = new Map(); lex.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (k + i + 1))); den.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + w / (k + i + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 50).map((e) => e[0]); };
const r2Hit = (q, lex) => { const top = byId.get(lex[0]); if (!top) return false; const x = q.trim().toLowerCase(); return x === top.name.toLowerCase() || x === `${top.owner}.${top.name}`.toLowerCase() || x === `${top.fw}.${top.name}`.toLowerCase(); };
const trig = (q, n) => { const t = q.trim(); return !/\s/.test(t) && t.length >= n; };
const R3 = (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : r.den);
const R5n = (n) => (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : trig(r.q, n) ? wrrf(r.lexF, r.den, 1) : r.den);
const ARM = { F: (r) => r.lexF, F2: (r) => r.lexF2, D: (r) => r.den, R3, R5: R5n(5), R5t4: R5n(4), R5t6: R5n(6), nolex: (r) => nolex.get(`${r.set}|${r.id}`).list };
const mulberry = (seed) => { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const boot = (d) => { const n = d.length; if (!n) return null; const r = mulberry(42); const m = []; for (let i = 0; i < 10000; i++) { let s = 0; for (let j = 0; j < n; j++) s += d[Math.floor(r() * n)]; m.push(s / n); } m.sort((x, y) => x - y); return { n, mean: +(100 * d.reduce((x, y) => x + y, 0) / n).toFixed(1), p5: +(100 * m[500]).toFixed(1), p95: +(100 * m[9500]).toFixed(1) }; };
const sel = (set, f = () => true) => rows.filter((r) => r.set === set && f(r));
const rec = (rs, a) => +(rs.reduce((s, r) => s + hit(ARM[a](r), r.id), 0) / (rs.length || 1)).toFixed(3);
const diff = (rs, a, b) => boot(rs.map((r) => hit(ARM[a](r), r.id) - hit(ARM[b](r), r.id)));
const out = { table: {}, strata: {}, diffs: {}, conditions: {}, trigCounts: {} };
const SETS = ['V3', 'I3', 'M4', 'M5', 'I5', 'I6']; const names = Object.keys(ARM);
for (const s of SETS) { const rs = sel(s); out.table[s] = { n: rs.length, ...Object.fromEntries(names.filter((a) => a !== 'nolex' || nolex.has(`${s}|${rs[0]?.id}`)).map((a) => [a, rec(rs, a)])) }; out.trigCounts[s] = rs.filter((r) => !r2Hit(r.q, r.lexF2) && trig(r.q, 5)).length; }
const RULES = ['exact', 'qualified', 'lowerjoined', 'moduleMember', 'fragment', 'misspelled'];
for (const s of ['I5', 'I6']) for (const ru of RULES) { const rs = sel(s, (r) => r.rule === ru); (out.strata[s] ??= {})[ru] = { n: rs.length, F: rec(rs, 'F'), D: rec(rs, 'D'), R3: rec(rs, 'R3'), R5: rec(rs, 'R5'), R5t4: rec(rs, 'R5t4'), R5t6: rec(rs, 'R5t6'), nolex: rec(rs, 'nolex'), R5_R3: diff(rs, 'R5', 'R3') }; }
const i6 = sel('I6'), pooled = [...sel('I5'), ...sel('I6')];
const S1 = diff(i6, 'R5', 'R3'); const frag = sel('I6', (r) => r.rule === 'fragment'); const S2 = diff(frag, 'R5', 'R3'); const S3 = diff(sel('I6', (r) => r.rule === 'misspelled'), 'R5', 'R3');
const S4 = Object.fromEntries(['exact', 'qualified', 'lowerjoined', 'moduleMember'].map((ru) => [ru, diff(sel('I6', (r) => r.rule === ru), 'R5', 'R3')]));
const S5 = Object.fromEntries(['M5', 'M4', 'V3', 'I5', 'I3'].map((s) => [s, diff(sel(s), 'R5', 'R3')]));
const S6 = diff(pooled, 'R5', 'R3'); const S7 = Object.fromEntries(['I6', 'I5', 'M5', 'V3'].map((s) => [s, diff(sel(s), 'nolex', 'R5')]));
out.diffs = { S1, S2, S3, S4, S5, S6, S7, t4_vs_R5_I6: diff(i6, 'R5t4', 'R5'), t6_vs_R5_I6: diff(i6, 'R5t6', 'R5'), D_vs_R3_I6: diff(i6, 'R3', 'D') };
const c = out.conditions;
c.S1 = { met: S1.mean >= 3 && S1.p5 > 0, ...S1 }; c.S2 = { met: S2.mean >= 20 && S2.p5 > 0, ...S2 }; c.S3 = { met: S3.mean >= -5, ...S3 };
c.S4 = { met: Object.values(S4).every((x) => Math.abs(x.mean) <= 1), ...S4 };
c.S5 = { met: ['M5', 'M4', 'V3'].every((s) => Math.abs(S5[s].mean) <= 0.5) && Object.values(S5).every((x) => x.mean >= -1), ...S5 };
c.S6 = { met: S6.mean >= 3 && S6.p5 > 0, ...S6 }; c.S7 = { met: Object.values(S7).every((x) => x.mean >= -1.5), ...S7 };
// latency
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1); };
const latOf = (pass) => { const nt = pass.ms.filter((m) => !m.trig), tr = pass.ms.filter((m) => m.trig); const comp = (xs, k) => ({ p50: pct(xs.map((m) => m[k]), 0.5), p95: pct(xs.map((m) => m[k]), 0.95) });
  return { load1: pass.load1, nonTrigger: { n: nt.length, total: comp(nt, 'total'), embed: comp(nt, 'embed'), scan: comp(nt, 'scan'), map: comp(nt, 'map') }, trigger: { n: tr.length, total: comp(tr, 'total'), trigram: comp(tr, 'trigram') }, overall: comp(pass.ms, 'total'), triggerRate: +(tr.length / pass.ms.length).toFixed(3) }; };
out.latency = lats.flatMap((l) => l.passes).map(latOf);
const valid = out.latency.filter((p) => p.load1 < 1.5); out.latencyValidPasses = valid.length;
const take = valid.slice(0, 3);
c.S8 = { met: take.length === 3 && take.every((p) => p.nonTrigger.total.p95 <= 50), validPasses: valid.length, nonTriggerP95: take.map((p) => p.nonTrigger.total.p95), median: take.length ? [...take.map((p) => p.nonTrigger.total.p95)].sort((a, b) => a - b)[Math.floor(take.length / 2)] : null };
c.S9 = { triggerP95: take.map((p) => p.trigger.total.p95), overallP95: take.map((p) => p.overall.p95), triggerRate: take.map((p) => p.triggerRate) };
fs.writeFileSync(A.out, JSON.stringify(out, null, 1)); console.log(JSON.stringify({ table: out.table, trigCounts: out.trigCounts, conditions: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.met ?? null])), latencyValid: valid.length }));
