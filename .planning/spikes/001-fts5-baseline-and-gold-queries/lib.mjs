// Shared harness pieces: gold loading, FTS5 baseline, metrics. Pre-registered query construction below.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const STOP = new Set('the and for with from that this are was were into over than then them they their there which what when where while will would should could about after before been being does done each have has had its not only other out our such via use used using how why who whom any all can one two but nor yet per are also may might must shall your you'.split(' '));
export const tokens = (q) => [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)))];

export function loadDocs(dataDir) {
  return JSON.parse(fs.readFileSync(`${dataDir}/docs.json`, 'utf8')).docs;
}

/** gold: [[nameOrIdSuffix, query]]; resolves to a unique doc id inside the slice. */
export function resolveGold(docs, slice, pairs) {
  const pool = docs.filter((d) => d.slice === slice);
  return pairs.map(([key, q]) => {
    const hits = pool.filter((d) => (slice === 'b' ? d.id === `b:${key}` : d.name === key));
    if (hits.length !== 1) throw new Error(`gold key ${key} resolves to ${hits.length} docs in slice ${slice}`);
    return { q, gold: hits[0].id, name: hits[0].name, nameSplit: hits[0].nameSplit, slice };
  });
}

export function buildFts(docs, slice) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(name, nameSplit, qual, doc, sig, id UNINDEXED, tokenize='trigram')`);
  const ins = db.prepare('INSERT INTO t(name,nameSplit,qual,doc,sig,id) VALUES (?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (const d of docs.filter((x) => x.slice === slice)) ins.run(d.name, d.nameSplit, d.qual, d.doc, d.sig, d.id);
  db.exec('COMMIT');
  const sel = db.prepare('SELECT id FROM t WHERE t MATCH ? ORDER BY bm25(t, 6.0, 4.0, 1.0, 1.0, 1.0), id LIMIT ?');
  return {
    search(q, k = 50) {
      const ts = tokens(q);
      if (!ts.length) return [];
      return sel.all(ts.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR '), k).map((r) => r.id);
    },
  };
}

export const overlaps = (g) => {
  const qt = new Set(tokens(g.q));
  const nt = tokens(`${g.name} ${g.nameSplit}`.replace(/[_.\-:]/g, ' ')).filter((t) => t.length >= 4);
  return nt.some((t) => [...qt].some((u) => u.includes(t) || (u.length >= 4 && t.includes(u))));
};

export function metrics(golds, rankFn) {
  const rows = golds.map((g) => {
    const ranked = rankFn(g);
    const pos = ranked.indexOf(g.gold);
    return { q: g.q, overlap: overlaps(g), pos };
  });
  const agg = (rs) => ({
    n: rs.length,
    r5: rs.filter((r) => r.pos >= 0 && r.pos < 5).length / (rs.length || 1),
    r10: rs.filter((r) => r.pos >= 0 && r.pos < 10).length / (rs.length || 1),
    mrr: rs.reduce((s, r) => s + (r.pos >= 0 ? 1 / (r.pos + 1) : 0), 0) / (rs.length || 1),
  });
  return { all: agg(rows), overlap: agg(rows.filter((r) => r.overlap)), noOverlap: agg(rows.filter((r) => !r.overlap)), rows };
}
