// Round 4 scoring (plan section 13). usage: node score4.mjs --data <dir> --base lists-base.json --out result.json [--sw lists-sw.json] [--rr rerank.json] [--plists primary-lists.json]
// Stage 1 (no --rr): reproduction gate, router arms, conditions P1-P4, Pool-lite, Swift prose; writes primary candidate lists for the reranker.
// Stage 2 (--rr): adds RR50 / RR20 arms and conditions RK1-RK3.
import fs from 'node:fs'; import path from 'node:path';
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const { docs } = JSON.parse(fs.readFileSync(path.join(A.data, 'docs.json'), 'utf8')); const byId = new Map(docs.map((d) => [d.id, d]));
const base = JSON.parse(fs.readFileSync(A.base, 'utf8')); const sw = A.sw ? JSON.parse(fs.readFileSync(A.sw, 'utf8')) : null; const rrData = A.rr ? JSON.parse(fs.readFileSync(A.rr, 'utf8')) : null;
const key = (r) => `${r.set}|${r.id}`; const swBy = sw ? new Map(sw.rows.map((r) => [key(r), r])) : null;
const hit = (l, g, k = 10) => { const p = l.indexOf(g); return p >= 0 && p < k ? 1 : 0; };
const wrrf = (lex, den, w, k = 60) => { const m = new Map(); lex.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + 1 / (k + i + 1))); den.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + w / (k + i + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 50).map((e) => e[0]); };
const IDENT = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const knownModules = new Set(docs.filter((d) => d.slice === 'a').map((d) => d.fw.toLowerCase()));
const r1Ident = (q) => { const t = q.trim().split(/\s+/); return (t.length === 1 && IDENT.test(t[0])) || (t.length === 2 && IDENT.test(t[1]) && knownModules.has(t[0].toLowerCase())); };
const r2Hit = (q, lex) => { const top = byId.get(lex[0]); if (!top) return false; const x = q.trim().toLowerCase(); return x === top.name.toLowerCase() || x === `${top.owner}.${top.name}`.toLowerCase() || x === `${top.fw}.${top.name}`.toLowerCase(); };
const nameTok = (q, lex) => { const top = byId.get(lex[0]); if (!top) return false; const bits = new Set([top.name.toLowerCase(), ...top.nameSplit.toLowerCase().split(/\s+/)]); return q.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 4 && bits.has(w)); };
const mulberry = (seed) => { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const boot = (d) => { const n = d.length; if (!n) return null; const r = mulberry(42); const m = []; for (let i = 0; i < 10000; i++) { let s = 0; for (let j = 0; j < n; j++) s += d[Math.floor(r() * n)]; m.push(s / n); } m.sort((x, y) => x - y); return { n, mean: +(d.reduce((x, y) => x + y, 0) / n).toFixed(4), p5: +m[500].toFixed(4), p95: +m[9500].toFixed(4) }; };
const rows = base.rows; const sel = (set, sp, f = () => true) => rows.filter((r) => r.set === set && r.split === sp && f(r));
const r10 = (rs, f) => rs.reduce((s, r) => s + hit(f(r), r.id), 0) / (rs.length || 1);
// L as in round 3: the better of F / F2 on V3 tuning
const tF = r10(sel('V3', 'tuning'), (r) => r.lexF), tF2 = r10(sel('V3', 'tuning'), (r) => r.lexF2); const Lname = tF2 > tF + 1e-9 ? 'F2' : 'F'; const lexOf = (r) => (Lname === 'F2' ? r.lexF2 : r.lexF);
const route = { R2w3: (r, lex, den) => (r2Hit(r.q, lex) ? lex : wrrf(lex, den, 3)), R3: (r, lex, den) => (r2Hit(r.q, lex) ? lex : den), R4: (r, lex, den) => (r2Hit(r.q, lex) ? lex : nameTok(r.q, lex) ? wrrf(lex, den, 3) : den) };
const arm = (r, a) => { const lex = lexOf(r); switch (a) { case 'F': return r.lexF; case 'F2': return r.lexF2; case 'L': return lex; case 'D': return r.den; case 'E': return wrrf(lex, r.den, 1); default: return route[a](r, lex, r.den); } };
const tuneScore = (a) => (r10(sel('V3', 'tuning'), (r) => arm(r, a)) + r10(sel('I3', 'tuning'), (r) => arm(r, a)) + r10(sel('M4', 'tuning'), (r) => arm(r, a))) / 3;
const tuneTable = { R3: +tuneScore('R3').toFixed(4), R4: +tuneScore('R4').toFixed(4) }; const primary = tuneTable.R4 > tuneTable.R3 + 1e-9 ? 'R4' : 'R3';
const diff = (rs, fa, fb) => boot(rs.map((r) => hit(fa(r), r.id) - hit(fb(r), r.id)));
const ARMS = ['F', 'F2', 'L', 'D', 'E', 'R2w3', 'R3', 'R4']; const table = {};
for (const set of ['V3', 'I3', 'M4']) for (const sp of ['tuning', 'test']) table[`${set}.${sp}`] = { n: sel(set, sp).length, ...Object.fromEntries(ARMS.map((a) => [a, +r10(sel(set, sp), (r) => arm(r, a)).toFixed(3)])) };
const vt = sel('V3', 'test'), it = sel('I3', 'test'), mt = sel('M4', 'test'); const P = (r) => arm(r, primary);
const cmp = (rs, a, b) => diff(rs, (r) => arm(r, a), (r) => arm(r, b));
const out = { Lname, tuneFvsF2: { F: tF, F2: tF2 }, tuneTable, primary, table };
out.reproduction = { V3_D: table['V3.test'].D, V3_R2w3: table['V3.test'].R2w3, I3_D: table['I3.test'].D, I3_R2w3: table['I3.test'].R2w3, expected: { V3_D: 0.214, V3_R2w3: 0.18, I3_D: 0.836, I3_R2w3: 0.902 } };
out.reproduction.ok = Math.abs(out.reproduction.V3_D - 0.214) < 0.0015 && Math.abs(out.reproduction.V3_R2w3 - 0.18) < 0.0015 && Math.abs(out.reproduction.I3_D - 0.836) < 0.0015 && Math.abs(out.reproduction.I3_R2w3 - 0.902) < 0.0015;
const strata = {}; for (const st of ['A', 'B', 'C', 'D']) { const rs = vt.filter((r) => r.stratum === st); strata[st] = { n: rs.length, L: +r10(rs, (r) => arm(r, 'L')).toFixed(3), D: +r10(rs, (r) => arm(r, 'D')).toFixed(3), primary: +r10(rs, P).toFixed(3), primary_vs_L: cmp(rs, primary, 'L'), primary_vs_D: cmp(rs, primary, 'D') }; }
const m4strata = {}; for (const st of ['A', 'B', 'C', 'D']) { const rs = mt.filter((r) => r.stratum === st); m4strata[st] = { n: rs.length, L: +r10(rs, (r) => arm(r, 'L')).toFixed(3), D: +r10(rs, (r) => arm(r, 'D')).toFixed(3), E: +r10(rs, (r) => arm(r, 'E')).toFixed(3), primary: +r10(rs, P).toFixed(3) }; }
const perRule = {}; for (const r of it) (perRule[r.rule] ??= []).push(r); out.perRuleI3 = Object.fromEntries(Object.entries(perRule).map(([k, rs]) => [k, { n: rs.length, F: +r10(rs, (r) => r.lexF).toFixed(3), L: +r10(rs, (r) => arm(r, 'L')).toFixed(3), D: +r10(rs, (r) => arm(r, 'D')).toFixed(3), primary: +r10(rs, P).toFixed(3) }]));
out.strata = strata; out.m4strata = m4strata;
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
out.conditions = {
  P1: { desc: 'primary - D on V3 >= -1 pt', ...cmp(vt, primary, 'D'), met: cmp(vt, primary, 'D').mean >= -0.01 },
  P2: { desc: 'I3 primary >= F - 1 pt and >= R2w3 - 2 pts', vsF: cmp(it, primary, 'F'), vsR2w3: cmp(it, primary, 'R2w3'), met: cmp(it, primary, 'F').mean >= -0.01 && cmp(it, primary, 'R2w3').mean >= -0.02 },
  P3: { desc: 'M4 primary >= max(L, D) - 1 pt', primary: table['M4.test'][primary], L: table['M4.test'].L, D: table['M4.test'].D, E: table['M4.test'].E, vsBest: +(table['M4.test'][primary] - Math.max(table['M4.test'].L, table['M4.test'].D)).toFixed(3), met: table['M4.test'][primary] - Math.max(table['M4.test'].L, table['M4.test'].D) >= -0.01 },
  P4: { desc: 'primary - L on V3 >= +5 pts and p5 > 0', ...cmp(vt, primary, 'L'), met: cmp(vt, primary, 'L').mean >= 0.05 && cmp(vt, primary, 'L').p5 > 0 },
};
out.M4_vs = { primary_vs_L: cmp(mt, primary, 'L'), primary_vs_D: cmp(mt, primary, 'D'), primary_vs_E: cmp(mt, primary, 'E'), D_vs_L: cmp(mt, 'D', 'L'), E_vs_D: cmp(mt, 'E', 'D'), R4_vs_R3: cmp(mt, 'R4', 'R3'), R2w3_vs_primary: cmp(mt, 'R2w3', primary) };
// ---- Pool-lite
const lt = (rs, f) => r10(rs, f); const vin = vt.filter((r) => r.inLite), vall = vt;
const liteArm = (r) => { const lex = r.lexF2Lite; return primary === 'R4' ? (r2Hit(r.q, lex) ? lex : nameTok(r.q, lex) ? wrrf(lex, r.denLite, 3) : r.denLite) : r2Hit(r.q, lex) ? lex : r.denLite; };
out.lite = { liteSize: base.liteSize, goldInLite: { V3: rows.filter((r) => r.set === 'V3' && r.inLite).length, I3: rows.filter((r) => r.set === 'I3' && r.inLite).length, M4: rows.filter((r) => r.set === 'M4' && r.inLite).length }, inScopeV3test: { n: vin.length, D_full: +lt(vin, (r) => r.den).toFixed(3), D_lite: +lt(vin, (r) => r.denLite).toFixed(3), primary_full: +lt(vin, P).toFixed(3), primary_lite: +lt(vin, liteArm).toFixed(3), D_lite_vs_D_full: diff(vin, (r) => r.denLite, (r) => r.den) }, allV3test: { n: vall.length, D_full: +lt(vall, (r) => r.den).toFixed(3), D_lite: +lt(vall, (r) => r.denLite).toFixed(3), primary_full: +lt(vall, P).toFixed(3), primary_lite: +lt(vall, liteArm).toFixed(3) }, allI3test: { n: it.length, primary_full: +lt(it, P).toFixed(3), primary_lite: +lt(it, liteArm).toFixed(3) }, allM4test: { n: mt.length, primary_full: +lt(mt, P).toFixed(3), primary_lite: +lt(mt, liteArm).toFixed(3) } };
out.conditions.L1 = { desc: 'in scope V3 test: D_lite - D_full >= -1 pt', ...out.lite.inScopeV3test.D_lite_vs_D_full, met: out.lite.inScopeV3test.D_lite_vs_D_full.mean >= -0.01 };
// ---- Swift prose
if (sw) {
  const sr = (r) => swBy.get(key(r)); const swArm = (r, a) => { const s = sr(r); const lex = Lname === 'F2' ? s.lexF2 : s.lexF; return a === 'D' ? s.den : a === 'L' ? lex : primary === 'R4' ? route.R4(s, lex, s.den) : route.R3(s, lex, s.den); };
  const cs = vt.filter((r) => r.stratum === 'C' || r.stratum === 'D'); const dd = (rs, a, b) => boot(rs.map((r) => hit(swArm(r, a), r.id) - hit(b(r), r.id)));
  out.swift = { enriched: sw.reembedded, reembedSec: sw.reembedSec, CD: { n: cs.length, D_base: +r10(cs, (r) => r.den).toFixed(3), D_sw: +r10(cs, (r) => swArm(r, 'D')).toFixed(3), primary_base: +r10(cs, P).toFixed(3), primary_sw: +r10(cs, (r) => swArm(r, 'primary')).toFixed(3), D_sw_vs_D: dd(cs, 'D', (r) => r.den), primary_sw_vs_primary: dd(cs, 'primary', P) }, byStratum: {}, others: {} };
  for (const st of ['A', 'B', 'C', 'D']) { const rs = vt.filter((r) => r.stratum === st); out.swift.byStratum[st] = { n: rs.length, D_base: +r10(rs, (r) => r.den).toFixed(3), D_sw: +r10(rs, (r) => swArm(r, 'D')).toFixed(3), D_sw_vs_D: dd(rs, 'D', (r) => r.den) }; }
  const ab = vt.filter((r) => r.stratum === 'A' || r.stratum === 'B');
  out.swift.others = { AB_D_sw_vs_D: dd(ab, 'D', (r) => r.den), I3_primary_sw_vs_primary: dd(it, 'primary', P), M4_primary_sw_vs_primary: dd(mt, 'primary', P), M4_swiftOnly: (() => { const rs = mt.filter((r) => r.part === 'swift'); return { n: rs.length, primary_base: +r10(rs, P).toFixed(3), primary_sw: +r10(rs, (r) => swArm(r, 'primary')).toFixed(3), D_base: +r10(rs, (r) => r.den).toFixed(3), D_sw: +r10(rs, (r) => swArm(r, 'D')).toFixed(3) }; })() };
  out.conditions.SW1 = { desc: 'V3 C+D: D_sw - D >= +3 pts and p5 > 0', ...out.swift.CD.D_sw_vs_D, met: out.swift.CD.D_sw_vs_D.mean >= 0.03 && out.swift.CD.D_sw_vs_D.p5 > 0 };
  out.conditions.SW2 = { desc: 'A,B D_sw not below D by > 1 pt; I3 and M4 primary_sw not below primary by > 1 pt', AB: out.swift.others.AB_D_sw_vs_D, I3: out.swift.others.I3_primary_sw_vs_primary, M4: out.swift.others.M4_primary_sw_vs_primary, met: out.swift.others.AB_D_sw_vs_D.mean >= -0.01 && out.swift.others.I3_primary_sw_vs_primary.mean >= -0.01 && out.swift.others.M4_primary_sw_vs_primary.mean >= -0.01 };
}
// ---- reranker
if (rrData) {
  const rl = (r, n) => rrData.lists[key(r)][`rr${n}`]; const keepLex = (r) => r2Hit(r.q, lexOf(r));
  const rrArm = (r, n) => (keepLex(r) ? P(r) : rl(r, n)); const rcmp = (rs, n) => boot(rs.map((r) => hit(rrArm(r, n), r.id) - hit(P(r), r.id)));
  out.rerank = { model: rrData.model, V3: { primary: +r10(vt, P).toFixed(3), RR50: +r10(vt, (r) => rrArm(r, 50)).toFixed(3), RR20: +r10(vt, (r) => rrArm(r, 20)).toFixed(3), RR50_vs_primary: rcmp(vt, 50), RR20_vs_primary: rcmp(vt, 20) }, I3: { primary: +r10(it, P).toFixed(3), RR50: +r10(it, (r) => rrArm(r, 50)).toFixed(3), RR50_vs_primary: rcmp(it, 50) }, M4: { primary: +r10(mt, P).toFixed(3), RR50: +r10(mt, (r) => rrArm(r, 50)).toFixed(3), RR50_vs_primary: rcmp(mt, 50) }, strata: {}, recall50: null,latency: rrData.latency, determinism: rrData.determinism };
  for (const st of ['A', 'B', 'C', 'D']) { const rs = vt.filter((r) => r.stratum === st); out.rerank.strata[st] = { n: rs.length, primary: +r10(rs, P).toFixed(3), RR50: +r10(rs, (r) => rrArm(r, 50)).toFixed(3), delta: rcmp(rs, 50) }; }
  out.rerank.recall50 = { V3_in_top50_of_primary: +(vt.reduce((s, r) => s + hit(P(r), r.id, 50), 0) / vt.length).toFixed(3) };
  out.conditions.RK1 = { desc: 'V3: RR50 - primary >= +3 pts and p5 > 0', ...out.rerank.V3.RR50_vs_primary, met: out.rerank.V3.RR50_vs_primary.mean >= 0.03 && out.rerank.V3.RR50_vs_primary.p5 > 0 };
  out.conditions.RK2 = { desc: 'I3 and M4: RR50 not below primary by > 1 pt', I3: out.rerank.I3.RR50_vs_primary, M4: out.rerank.M4.RR50_vs_primary, met: out.rerank.I3.RR50_vs_primary.mean >= -0.01 && out.rerank.M4.RR50_vs_primary.mean >= -0.01 };
  out.conditions.RK3 = { desc: 'two reranker runs on 60 queries give identical top-10 lists', ...rrData.determinism, met: rrData.determinism?.identical === rrData.determinism?.n };
}
// primary candidate lists for the reranker
if (!A.rr) { const pl = {}; for (const r of rows) { const lex = lexOf(r); pl[key(r)] = { q: r.q, list: P(r), keepLex: r2Hit(r.q, lex) }; } fs.writeFileSync(A.plists ?? 'primary-lists.json', JSON.stringify({ primary, lists: pl })); }
out.latencyMs = (() => { const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)]; const e = rows.map((r) => r.ms.embed), s = rows.map((r) => r.ms.scan), f = rows.map((r) => r.ms.fts); return { embedP95: +p95(e).toFixed(1), scanP95: +p95(s).toFixed(1), ftsP95: +p95(f).toFixed(1), addedP95: +p95(rows.map((r) => r.ms.embed + r.ms.scan + r.ms.fts)).toFixed(1) }; })();
fs.writeFileSync(A.out, JSON.stringify(out, null, 1)); console.log(JSON.stringify({ primary, Lname, tuneTable, reproduction: out.reproduction, conditions: Object.fromEntries(Object.entries(out.conditions).map(([k, v]) => [k, v.met ?? null])) }));
console.table(table); void mean;
