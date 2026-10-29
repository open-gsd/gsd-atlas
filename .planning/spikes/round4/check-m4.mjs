// Overlap checker for M4 queries (text only, never search output). usage: OUT=<ok.json> node check-m4.mjs <sdk-data-dir> <queries.json> [more.json ...]
// Accepts a query only when (a) it has 5..25 words, (b) it contains at least one whole word of 3+ letters that is a piece of the target name, owner or framework (camel-case split), and (c) it does not contain the full declaration name as one word.
import fs from 'node:fs'; import path from 'node:path';
const words = (t) => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const camel = (t) => t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
const [dataDir, ...files] = process.argv.slice(2);
const { docs } = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs.json'), 'utf8')); const byId = new Map(docs.map((d) => [d.id, d]));
const res = { ok: [], rejected: [] };
for (const f of files) for (const [id, q] of JSON.parse(fs.readFileSync(f, 'utf8'))) {
  const d = byId.get(id); if (!d) { res.rejected.push({ id, q, why: 'unknown id' }); continue; }
  const bits = new Set([...words(camel(d.name)), ...words(camel(d.owner)), ...words(camel(d.fw))].filter((w) => w.length >= 3));
  const qw = words(q); const why = [];
  if (!qw.some((w) => bits.has(w))) why.push('no name/owner/framework piece');
  if (qw.includes(d.name.toLowerCase()) && d.name.length >= 4) why.push('contains full name');
  if (qw.length < 5 || qw.length > 25) why.push(`length ${qw.length}`);
  (why.length ? res.rejected.push({ id, q, why: why.join('; ') }) : res.ok.push([id, q]));
}
console.log(JSON.stringify({ ok: res.ok.length, rejected: res.rejected.length }));
for (const r of res.rejected) console.log('REJECT', r.id.split(':').slice(-1)[0], '|', r.why, '|', r.q);
fs.writeFileSync(process.env.OUT ?? '/dev/null', JSON.stringify(res.ok, null, 1));
