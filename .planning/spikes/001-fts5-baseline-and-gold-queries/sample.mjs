// Seeded sample of gold targets per slice. Does NOT run any search.
import fs from 'node:fs';
const [dataDir, slice, n, seed] = process.argv.slice(2);
const { docs } = JSON.parse(fs.readFileSync(`${dataDir}/docs.json`, 'utf8'));
let s = Number(seed) >>> 0;
const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pool = docs.filter((d) => d.slice === slice[0] && (slice === 'b' || d.doc.length >= 40));
const count = new Map(); for (const d of pool) count.set(d.name, (count.get(d.name) ?? 0) + 1);
const uniq = pool.filter((d) => count.get(d.name) === 1);
for (let i = uniq.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [uniq[i], uniq[j]] = [uniq[j], uniq[i]]; }
for (const d of uniq.slice(0, Number(n))) console.log(JSON.stringify({ id: d.id, name: d.name, doc: d.doc.slice(0, slice === "b" ? 300 : 200) }));
