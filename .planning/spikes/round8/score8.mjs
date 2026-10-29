// Round 8 scoring (plan section 17). usage: node score8.mjs --data <dir> --r5 round5 lists-eg1.json --i6 round6 lists-i6.json --i8 lists-i8.json --lat latency8.json[,more.json] --out result.json
import fs from 'node:fs'; import path from 'node:path';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const { docs } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8')); const byId = new Map(docs.map((d) => [d.id, d]));
const rows = [...JSON.parse(fs.readFileSync(A.r5, 'utf8')).rows.filter((r) => r.split === 'test'), ...JSON.parse(fs.readFileSync(A.i6, 'utf8')).rows, ...JSON.parse(fs.readFileSync(A.i8, 'utf8')).rows];
const lats = A.lat.split(',').map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))); const lat = lats[0];
const nolex = new Map(lat.rows.map((r) => [`${r.set}|${r.id}`, r]));
const hit = (l, g, k = 10) => { const p = l.indexOf(g); return p >= 0 && p < k ? 1 : 0; };
const wrrf = (lex, den, w, k = 60) => { const m = new Map(); lex.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (k + i + 1))); den.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + w / (k + i + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 50).map((e) => e[0]); };
const r2Hit = (q, lex) => { const top = byId.get(lex[0]); if (!top) return false; const x = q.trim().toLowerCase(); return x === top.name.toLowerCase() || x === `${top.owner}.${top.name}`.toLowerCase() || x === `${top.fw}.${top.name}`.toLowerCase(); };
const trig5 = (q) => { const t = q.trim(); return !/\s/.test(t) && t.length >= 5; };
const trig6 = (q) => trig5(q) && !q.trim().includes('.');
const R3 = (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : r.den);
const R5 = (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : trig5(r.q) ? wrrf(r.lexF, r.den, 1) : r.den);
const R6 = (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : trig6(r.q) ? wrrf(r.lexF, r.den, 1) : r.den);
const ARM = { F: (r) => r.lexF, F2: (r) => r.lexF2, D: (r) => r.den, R3, R5, R6, nolex: (r) => nolex.get(`${r.set}|${r.id}`).list };
const mulberry = (seed) => { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const boot = (d) => { const n = d.length; if (!n) return null; const r = mulberry(42); const m = []; for (let i = 0; i < 10000; i++) { let s = 0; for (let j = 0; j < n; j++) s += d[Math.floor(r() * n)]; m.push(s / n); } m.sort((x, y) => x - y); return { n, mean: +(100 * d.reduce((x, y) => x + y, 0) / n).toFixed(1), p5: +(100 * m[500]).toFixed(1), p95: +(100 * m[9500]).toFixed(1) }; };
const sel = (set, f = () => true) => rows.filter((r) => r.set === set && f(r));
const rec = (rs, a) => +(rs.reduce((s, r) => s + hit(ARM[a](r), r.id), 0) / (rs.length || 1)).toFixed(3);
const diff = (rs, a, b) => boot(rs.map((r) => hit(ARM[a](r), r.id) - hit(ARM[b](r), r.id)));
const out = { table: {}, strata: {}, diffs: {}, conditions: {}, counts: {} };
const SETS = ['V3', 'I3', 'M4', 'M5', 'I5', 'I6', 'I8']; const names = Object.keys(ARM);
for (const s of SETS) { const rs = sel(s); out.table[s] = { n: rs.length, ...Object.fromEntries(names.filter((a) => a !== 'nolex' || nolex.has(`${s}|${rs[0]?.id}`)).map((a) => [a, rec(rs, a)])) };
  out.counts[s] = { dotted: rs.filter((r) => r.q.includes('.')).length, trigR5: rs.filter((r) => !r2Hit(r.q, r.lexF2) && trig5(r.q)).length, trigR6: rs.filter((r) => !r2Hit(r.q, r.lexF2) && trig6(r.q)).length, routedDifferently: rs.filter((r) => JSON.stringify(R5(r)) !== JSON.stringify(R6(r))).length }; }
const RULES = ['exact', 'qualified', 'lowerjoined', 'moduleMember', 'fragment', 'misspelled'];
for (const s of ['I5', 'I6', 'I8']) for (const ru of RULES) { const rs = sel(s, (r) => r.rule === ru); (out.strata[s] ??= {})[ru] = { n: rs.length, F: rec(rs, 'F'), D: rec(rs, 'D'), R3: rec(rs, 'R3'), R5: rec(rs, 'R5'), R6: rec(rs, 'R6'), nolex: rec(rs, 'nolex'), R6_R3: diff(rs, 'R6', 'R3'), R6_R5: diff(rs, 'R6', 'R5') }; }
const i8 = sel('I8');
const T1 = diff(i8, 'R6', 'R3'); const T2 = diff(sel('I8', (r) => r.rule === 'fragment'), 'R6', 'R3'); const T3 = diff(sel('I8', (r) => r.rule === 'misspelled'), 'R6', 'R3');
const T4 = Object.fromEntries(['exact', 'qualified', 'lowerjoined', 'moduleMember'].map((ru) => [ru, diff(sel('I8', (r) => r.rule === ru), 'R6', 'R3')]));
const T5 = Object.fromEntries(['M5', 'M4', 'V3', 'I5', 'I3', 'I6'].map((s) => [s, diff(sel(s), 'R6', 'R3')]));
const T6 = Object.fromEntries(['I8', 'I6', 'M5', 'V3'].map((s) => [s, diff(sel(s), 'nolex', 'R6')]));
const t7r = sel('I6', (r) => r.q === 'USDKit.arrayCount'); const T7 = { n: t7r.length, R3: t7r.map((r) => hit(R3(r), r.id)), R5: t7r.map((r) => hit(R5(r), r.id)), R6: t7r.map((r) => hit(R6(r), r.id)) };
out.diffs = { T1, T2, T3, T4, T5, T6, R5_vs_R3_I8: diff(i8, 'R5', 'R3'), R6_vs_R5_I8: diff(i8, 'R6', 'R5') };
const c = out.conditions;
c.T1 = { met: T1.mean >= 3 && T1.p5 > 0, ...T1 }; c.T2 = { met: T2.mean >= 20 && T2.p5 > 0, ...T2 }; c.T3 = { met: T3.mean >= -5, ...T3 };
c.T4 = { met: Object.values(T4).every((x) => Math.abs(x.mean) <= 1), ...T4 };
c.T5 = { met: ['M5', 'M4', 'V3'].every((s) => Math.abs(T5[s].mean) <= 0.5) && Object.values(T5).every((x) => x.mean >= -1), note: 'T5 plan set: M5, M4, V3 (within 0.5), all replay sets no loss over 1 pt; I5, I3, I6 are seen sets', ...T5 };
c.T6 = { met: Object.values(T6).every((x) => x.mean >= -1.5), ...T6 }; c.T7 = { met: T7.n === 1 && T7.R6[0] === 1, ...T7 };
// latency (L1): the round 6 mix of 722 queries only (I8 rows are in the file for recall)
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1); };
const latOf = (pass) => { const mix = pass.ms.filter((m) => m.set !== 'I8'); const nt = mix.filter((m) => !m.trig), tr = mix.filter((m) => m.trig); const comp = (xs, k) => ({ p50: pct(xs.map((m) => m[k]), 0.5), p95: pct(xs.map((m) => m[k]), 0.95) });
  return { load1: pass.load1, cpuIdle: pass.cpuIdle, load1End: pass.load1End, cpuIdleEnd: pass.cpuIdleEnd, mixN: mix.length, nonTrigger: { n: nt.length, total: comp(nt, 'total'), embed: comp(nt, 'embed'), scan: comp(nt, 'scan'), map: comp(nt, 'map') }, trigger: { n: tr.length, total: comp(tr, 'total'), trigram: comp(tr, 'trigram') }, overall: comp(mix, 'total'), triggerRate: +(tr.length / mix.length).toFixed(3) }; };
out.latency = lats.flatMap((l) => l.passes).map(latOf);
const ok = (p) => p.load1 <= 6 && p.cpuIdle !== null && p.cpuIdle >= 60; const inc = out.latency.filter(ok); const take = inc.slice(0, 3);
c.L1 = { met: take.length === 3 && take.every((p) => p.nonTrigger.total.p95 <= 50) && [...take.map((p) => p.nonTrigger.total.p95)].sort((a, b) => a - b)[1] <= 50, includedPasses: inc.length, excluded: out.latency.length - inc.length, nonTriggerP95: take.map((p) => p.nonTrigger.total.p95), triggerP95: take.map((p) => p.trigger.total.p95), overallP95: take.map((p) => p.overall.p95), triggerRate: take.map((p) => p.triggerRate) };
fs.writeFileSync(A.out, JSON.stringify(out, null, 1)); console.log(JSON.stringify({ table: out.table, counts: out.counts, conditions: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.met ?? null])) }));
