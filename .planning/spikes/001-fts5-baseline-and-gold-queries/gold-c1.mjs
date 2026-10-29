// Mechanical identifier-like queries for slice c1. Seeded sample, no search is run here.
import { loadDocs } from './lib.mjs';
export function makeC1(dataDir, n = 40, seed = 777) {
  const docs = loadDocs(dataDir);
  const count = new Map();
  for (const d of docs.filter((x) => x.slice === 'c')) count.set(d.name, (count.get(d.name) ?? 0) + 1);
  const pool = docs.filter((d) => d.slice === 'c' && count.get(d.name) === 1 && d.name.replace(/^_+/, '').length >= 7);
  let s = seed >>> 0;
  const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n).map((d, i) => {
    const bare = d.name.replace(/^_+/, '');
    const words = d.nameSplit.split(' ').filter(Boolean);
    // rule by index: 0 exact name, 1 spaced words, 2 prefix (first 2/3 of chars), 3 suffix (last 2/3)
    const q = [bare, words.join(' '), bare.slice(0, Math.max(5, Math.ceil(bare.length * 2 / 3))), bare.slice(bare.length - Math.max(5, Math.ceil(bare.length * 2 / 3)))][i % 4];
    return { q, gold: d.id, name: d.name, nameSplit: d.nameSplit, slice: 'c' };
  });
}
