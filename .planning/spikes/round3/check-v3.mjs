// Overlap checker for V3 queries (text only, never search output). usage: OUT=<ok.json> node check-v3.mjs <sdk-data-dir> <queries.json> [more.json ...]
// Rejects a query when (a) it contains any word piece (3+ letters) of the target's name, owner or framework, or (b) more than 1/3 of its content words appear as whole words (after crude stemming) in the target's name, declaration or documentation, or (c) length is outside 5..18 words.
import fs from 'node:fs'; import path from 'node:path';
const STOP = new Set('the and for with from that this are was were into over than then them they their there which what when where while will would should could about after before been being does done each have has had its not only other out our such via use used using how why who whom any all can one two but nor yet per also may might must shall your you get set make want need'.split(' '));
const stem = (w) => w.replace(/(ing|ed|es|s|ly)$/, '');
const words = (t) => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const content = (t) => [...new Set(words(t).filter((w) => w.length >= 3 && !STOP.has(w)))];
const camel = (t) => t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
const [dataDir, ...files] = process.argv.slice(2);
const { docs } = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs.json'), 'utf8')); const byId = new Map(docs.map((d) => [d.id, d]));
const res = { ok: [], rejected: [] };
for (const f of files) for (const [id, q] of JSON.parse(fs.readFileSync(f, 'utf8'))) {
  const d = byId.get(id); if (!d) { res.rejected.push({ id, q, why: 'unknown id' }); continue; }
  const nameBits = new Set([...words(camel(d.name)), ...words(camel(d.owner)), ...words(camel(d.fw))].filter((w) => w.length >= 3).map(stem));
  const qc = content(q); const nw = words(q).length;
  const hitName = qc.filter((w) => nameBits.has(stem(w)));
  const textWords = new Set(words(`${d.name} ${d.nameSplit} ${d.sig} ${d.doc}`).map(stem));
  const share = qc.filter((w) => textWords.has(stem(w))).length / (qc.length || 1);
  const why = [];
  if (hitName.length) why.push(`name piece: ${hitName.join(',')}`);
  if (share > 0.34) why.push(`share ${share.toFixed(2)}`);
  if (nw < 5 || nw > 18) why.push(`length ${nw}`);
  (why.length ? res.rejected.push({ id, q, why: why.join('; ') }) : res.ok.push([id, q]));
}
console.log(JSON.stringify({ ok: res.ok.length, rejected: res.rejected.length }));
for (const r of res.rejected) console.log('REJECT', r.id.split(':').slice(-1)[0], '|', r.why, '|', r.q);
fs.writeFileSync(process.env.OUT ?? '/dev/null', JSON.stringify(res.ok, null, 1));
