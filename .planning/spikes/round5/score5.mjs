// Round 5 scoring (plan section 14). usage: node score5.mjs --data <dir> --eg a.json[,b.json,c.json] [--qw qwen.json] [--rr rerank.json] --out result.json [--plists primary-lists.json]
import fs from 'node:fs'; import path from 'node:path';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const { docs } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8')); const byId = new Map(docs.map((d) => [d.id, d]));
const egFiles = A.eg.split(','); const egs = egFiles.map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))); const rows = egs[0].rows;
const qw = A.qw ? JSON.parse(fs.readFileSync(A.qw, 'utf8')) : null; const rrData = A.rr ? JSON.parse(fs.readFileSync(A.rr, 'utf8')) : null;
const key = (r) => `${r.set}|${r.id}`; const qwBy = qw ? new Map(qw.rows.map((r) => [key(r), r])) : null;
const hit = (l, g, k = 10) => { const p = l.indexOf(g); return p >= 0 && p < k ? 1 : 0; };
const wrrf = (lex, den, w, k = 60) => { const m = new Map(); lex.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (k + i + 1))); den.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + w / (k + i + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 50).map((e) => e[0]); };
const r2Hit = (q, lex) => { const top = byId.get(lex[0]); if (!top) return false; const x = q.trim().toLowerCase(); return x === top.name.toLowerCase() || x === `${top.owner}.${top.name}`.toLowerCase() || x === `${top.fw}.${top.name}`.toLowerCase(); };
const nameTok = (q, lex) => { const top = byId.get(lex[0]); if (!top) return false; const bits = new Set([top.name.toLowerCase(), ...top.nameSplit.toLowerCase().split(/\s+/)]); return q.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 4 && bits.has(w)); };
const mulberry = (seed) => { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const boot = (d) => { const n = d.length; if (!n) return null; const r = mulberry(42); const m = []; for (let i = 0; i < 10000; i++) { let s = 0; for (let j = 0; j < n; j++) s += d[Math.floor(r() * n)]; m.push(s / n); } m.sort((x, y) => x - y); return { n, mean: +(d.reduce((x, y) => x + y, 0) / n).toFixed(4), p5: +m[500].toFixed(4), p95: +m[9500].toFixed(4) }; };
const sel = (set, sp, f = () => true) => rows.filter((r) => r.set === set && r.split === sp && f(r));
const r10 = (rs, f) => rs.reduce((s, r) => s + hit(f(r), r.id), 0) / (rs.length || 1);
const lexOf = (r) => r.lexF2;
const ARM = {
  F: (r) => r.lexF, F2: (r) => r.lexF2, D: (r) => r.den, E: (r) => wrrf(r.lexF2, r.den, 1),
  R2w3: (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : wrrf(r.lexF2, r.den, 3)),
  R4: (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : nameTok(r.q, r.lexF2) ? wrrf(r.lexF2, r.den, 3) : r.den),
  R3: (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : r.den),
  R5: (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : (!/\s/.test(r.q.trim()) && r.q.trim().length >= 5 ? wrrf(r.lexF, r.den, 1) : r.den)),
  Rq: (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : r.denQ),
};
const lowOf = (r) => ARM.F(r); void lowOf;
const arm = (r, a) => ARM[a](r);
const cmp = (rs, a, b) => boot(rs.map((r) => hit(arm(r, a), r.id) - hit(arm(r, b), r.id)));
const rec = (rs, a) => +r10(rs, (r) => arm(r, a)).toFixed(3);
const SETS = ['V3', 'I3', 'M4', 'M5', 'I5']; const ARMS = ['F', 'F2', 'D', 'E', 'R2w3', 'R4', 'R3', 'R5', 'Rq'];
const table = {}; for (const set of SETS) for (const sp of ['tuning', 'test']) table[`${set}.${sp}`] = { n: sel(set, sp).length, ...Object.fromEntries(ARMS.map((a) => [a, rec(sel(set, sp), a)])) };
const T = Object.fromEntries(SETS.map((s) => [s, sel(s, 'test')])); const out = { table };
out.reproduction = { V3_D: table['V3.test'].D, V3_R3: table['V3.test'].R3, I3_R3: table['I3.test'].R3, M4_R3: table['M4.test'].R3, expected: { V3_D: 0.214, V3_R3: 0.214, I3_R3: 0.902, M4_R3: 0.921 } };
out.reproduction.ok = ['V3_D', 'V3_R3', 'I3_R3', 'M4_R3'].every((k) => Math.abs(out.reproduction[k] - out.reproduction.expected[k]) < 0.0015);
// R5 vs R3 decision on pooled tuning halves of M5 and I5
const tun = [...sel('M5', 'tuning'), ...sel('I5', 'tuning')]; const dPool = rec(tun, 'R5') - rec(tun, 'R3'); const dM5 = rec(sel('M5', 'tuning'), 'R5') - rec(sel('M5', 'tuning'), 'R3');
out.r5Decision = { pooledTuningN: tun.length, R3: rec(tun, 'R3'), R5: rec(tun, 'R5'), diff: +dPool.toFixed(4), M5tuningDiff: +dM5.toFixed(4), R5recommended: dPool >= 0.01 - 1e-9 && dM5 >= -1e-9 };
const best = (rs) => Math.max(rec(rs, 'F'), rec(rs, 'F2'));
const fresh = [...T.M5, ...T.I5];
const C = {};
C.Q1 = { desc: 'I5: R3 - D >= +3 pts, p5 > 0', ...cmp(T.I5, 'R3', 'D') }; C.Q1.met = C.Q1.mean >= 0.03 && C.Q1.p5 > 0;
C.Q2 = { desc: 'M5: R3 - D >= -1 pt', ...cmp(T.M5, 'R3', 'D') }; C.Q2.met = C.Q2.mean >= -0.01;
C.Q3 = { desc: 'R3 >= max(F, F2) - 1 pt on M5 and I5', M5: { R3: rec(T.M5, 'R3'), bestLexical: best(T.M5) }, I5: { R3: rec(T.I5, 'R3'), bestLexical: best(T.I5) } }; C.Q3.met = rec(T.M5, 'R3') >= best(T.M5) - 0.01 && rec(T.I5, 'R3') >= best(T.I5) - 0.01;
C.Q4 = { desc: 'V3 test: R3 - F2 >= +5 pts, p5 > 0', ...cmp(T.V3, 'R3', 'F2') }; C.Q4.met = C.Q4.mean >= 0.05 && C.Q4.p5 > 0;
C.Q5 = { desc: 'I5: R5 - R3 >= +2 pts, p5 > 0; M5 within 0.5 pt', I5: cmp(T.I5, 'R5', 'R3'), M5: cmp(T.M5, 'R5', 'R3'), recommendedByTuningRule: out.r5Decision.R5recommended }; C.Q5.met = C.Q5.I5.mean >= 0.02 && C.Q5.I5.p5 > 0 && Math.abs(C.Q5.M5.mean) <= 0.005;
if (qw) { const q = (set, a) => { const rs = qw.rows.filter((r) => r.set === set && r.split === 'test'); const f = a === 'D' ? (r) => r.den : (r) => (r2Hit(r.q, r.lexF2) ? r.lexF2 : r.den); return { n: rs.length, recall: +r10(rs, f).toFixed(3), diffs: rs.map((r) => hit(a === 'D' ? r.den : (r2Hit(r.q, r.lexF2) ? r.lexF2 : r.den), r.id)) }; };
  const dq = (set) => { const rs = qw.rows.filter((r) => r.set === set && r.split === 'test'); return boot(rs.map((r) => hit(r2Hit(r.q, r.lexF2) ? r.lexF2 : r.den, r.id) - hit(r.den, r.id))); };
  C.Q7 = { desc: 'Qwen3: M5 R3 - D >= -1 pt; I5 R3 - D >= 0', M5: dq('M5'), I5: dq('I5'), V3: dq('V3'), M4: dq('M4'), recall: Object.fromEntries(SETS.map((s) => [s, { D: q(s, 'D').recall, R3: q(s, 'R3').recall }])) }; C.Q7.met = C.Q7.M5.mean >= -0.01 && C.Q7.I5.mean >= 0; }
C.Q8 = { desc: 'Rq within 1 pt of R3 on M5, I5, V3 (paired mean)', M5: cmp(T.M5, 'Rq', 'R3'), I5: cmp(T.I5, 'Rq', 'R3'), V3: cmp(T.V3, 'Rq', 'R3'), M4: cmp(T.M4, 'Rq', 'R3'), I3: cmp(T.I3, 'Rq', 'R3') }; C.Q8.met = ['M5', 'I5', 'V3'].every((k) => C.Q8[k].mean >= -0.01);
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)]; const lat = (e) => ({ f32: +p95(e.rows.map((r) => r.ms.embed + r.ms.scanF32 + r.ms.f2)).toFixed(1), i8: +p95(e.rows.map((r) => r.ms.embed + r.ms.scanI8 + r.ms.f2)).toFixed(1), embed: +p95(e.rows.map((r) => r.ms.embed)).toFixed(1), scanF32: +p95(e.rows.map((r) => r.ms.scanF32)).toFixed(1), scanI8: +p95(e.rows.map((r) => r.ms.scanI8)).toFixed(1), f2: +p95(e.rows.map((r) => r.ms.f2)).toFixed(1) });
C.Q8.latencyP95PerPass = egs.map(lat); C.Q8.latencyMedianAddedP95_i8 = +[...C.Q8.latencyP95PerPass.map((l) => l.i8)].sort((a, b) => a - b)[Math.floor(egs.length / 2)].toFixed(1);
C.Q9 = { M5test: T.M5.length, I5test: T.I5.length, underpoweredM5: T.M5.length < 80, underpoweredI5: T.I5.length < 60 };
// strata and rules
out.strata = {}; for (const set of ['V3', 'M4', 'M5']) { out.strata[set] = {}; for (const st of ['A', 'B', 'C', 'D']) { const rs = T[set].filter((r) => r.stratum === st); out.strata[set][st] = { n: rs.length, F: rec(rs, 'F'), F2: rec(rs, 'F2'), D: rec(rs, 'D'), R3: rec(rs, 'R3') }; } }
out.perRuleI5 = {}; for (const r of T.I5) (out.perRuleI5[r.rule] ??= []).push(r); out.perRuleI5 = Object.fromEntries(Object.entries(out.perRuleI5).map(([k, rs]) => [k, { n: rs.length, F: rec(rs, 'F'), F2: rec(rs, 'F2'), D: rec(rs, 'D'), R3: rec(rs, 'R3'), R5: rec(rs, 'R5') }]));
out.M5vs = { R3_vs_F: cmp(T.M5, 'R3', 'F'), R3_vs_F2: cmp(T.M5, 'R3', 'F2'), D_vs_F: cmp(T.M5, 'D', 'F'), E_vs_D: cmp(T.M5, 'E', 'D'), R4_vs_R3: cmp(T.M5, 'R4', 'R3'), R2w3_vs_R3: cmp(T.M5, 'R2w3', 'R3') }; out.I5vs = { R3_vs_F: cmp(T.I5, 'R3', 'F'), R4_vs_R3: cmp(T.I5, 'R4', 'R3'), E_vs_R3: cmp(T.I5, 'E', 'R3') };
// reranker
if (rrData) { const rl = (r, n) => rrData.lists[key(r)][`rr${n}`]; const rrArm = (r, n) => rl(r, n); const rcmp = (rs, n) => boot(rs.map((r) => hit(rrArm(r, n), r.id) - hit(arm(r, 'R3'), r.id)));
  out.rerank = { pooled: { n: fresh.length, R3: rec(fresh, 'R3'), RR50: +r10(fresh, (r) => rrArm(r, 50)).toFixed(3), RR20: +r10(fresh, (r) => rrArm(r, 20)).toFixed(3), RR50_vs_R3: rcmp(fresh, 50), RR20_vs_R3: rcmp(fresh, 20) }, M5: { R3: rec(T.M5, 'R3'), RR50: +r10(T.M5, (r) => rrArm(r, 50)).toFixed(3), RR50_vs_R3: rcmp(T.M5, 50) }, I5: { R3: rec(T.I5, 'R3'), RR50: +r10(T.I5, (r) => rrArm(r, 50)).toFixed(3), RR50_vs_R3: rcmp(T.I5, 50) }, latency: rrData.latency, determinism: rrData.determinism };
  C.Q6 = { desc: 'pooled fresh test: RR50 - R3 >= +3 pts, p5 > 0; determinism 60/60', ...out.rerank.pooled.RR50_vs_R3, determinism: rrData.determinism }; C.Q6.met = C.Q6.mean >= 0.03 && C.Q6.p5 > 0 && rrData.determinism?.identical === rrData.determinism?.n; }
out.conditions = C;
if (!A.rr && A.plists) { const pl = {}; for (const r of rows) { if (r.set !== 'M5' && r.set !== 'I5') continue; pl[key(r)] = { q: r.q, list: arm(r, 'R3'), keepLex: r2Hit(r.q, r.lexF2) }; } fs.writeFileSync(A.plists, JSON.stringify({ primary: 'R3', lists: pl })); }
fs.writeFileSync(A.out, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ reproduction: out.reproduction, r5Decision: out.r5Decision, conditions: Object.fromEntries(Object.entries(C).map(([k, v]) => [k, v.met ?? null])) })); console.table(table);
