// Per-author and per-pool-part recall@10 on the V2 test half from result files. usage: node breakdown.mjs <result.json> ...
import fs from 'node:fs';
const authors = JSON.parse(fs.readFileSync(new URL('./gold-v2.authors.json', import.meta.url)));
for (const f of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8')); const rows = Object.entries(r.top10).filter(([k, v]) => k.startsWith('V2|') && v.split === 'test').map(([k, v]) => ({ id: k.slice(3), ...v }));
  const grp = (keyFn) => { const m = {}; for (const x of rows) (m[keyFn(x)] ??= []).push(x); return m; };
  const rec = (rs, a) => +(rs.filter((x) => x[a].includes(x.id)).length / rs.length).toFixed(3);
  const out = {}; for (const [name, fn] of [['author', (x) => authors[x.id]], ['part', (x) => (x.id.startsWith('a:tslib:') ? 'tslib' : 'node')], ['tslibFile', (x) => (x.id.startsWith('a:tslib:') ? x.id.split(':')[2].replace('.d.ts', '') : 'node')]]) {
    out[name] = Object.fromEntries(Object.entries(grp(fn)).map(([k, rs]) => [k, { n: rs.length, F: rec(rs, 'F'), D: rec(rs, 'D'), primary: rec(rs, 'primary') }]));
  }
  console.log(f.split('/').pop(), JSON.stringify(out));
}
