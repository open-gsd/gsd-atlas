// Draws V2 targets (seed 31) and writes author work files. No search is run.
// usage: node sample-v2.mjs <poolb-data-dir> <round1-gold-dir> <out-dir>
import fs from 'node:fs'; import path from 'node:path';
const [dataDir, goldDir, outDir] = process.argv.slice(2);
const { docs } = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs.json'), 'utf8'));
const pool = docs.filter((d) => d.slice === 'a');
const ownerOf = (d) => (d.part === 'tslib' ? d.id.split(':').slice(4).join(':').replace(/\.[^.]+$/, '') : '');
const key = (d) => `${ownerOf(d)}|${d.name}`;
const cnt = new Map(); for (const d of pool) cnt.set(key(d), (cnt.get(key(d)) ?? 0) + 1);
const used = new Set([...JSON.parse(fs.readFileSync(path.join(goldDir, 'gold-a.json'), 'utf8')), ...JSON.parse(fs.readFileSync(path.join(goldDir, 'gold-a2.json'), 'utf8'))].map((x) => x[0]));
const elig = pool.filter((d) => cnt.get(key(d)) === 1 && d.doc.length >= 40 && d.name.length >= 3 && !(d.part === 'node' && used.has(d.name)));
let s = 31 >>> 0; const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuf = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const nodeAll = shuf(elig.filter((d) => d.part === 'node')), tsAll = shuf(elig.filter((d) => d.part === 'tslib'));
const node = nodeAll.slice(0, 70), ts = tsAll.slice(0, 70);
const all = shuf([...node, ...ts]);
const owner = all.slice(0, 55), agent = all.slice(55, 140);
const line = (d, i) => `${i + 1}. [${d.id}]\n   name: ${d.name}${ownerOf(d) ? `   (member of ${ownerOf(d)})` : `   (module ${d.qual})`}\n   declaration: ${d.sig}\n   documentation: ${d.doc.slice(0, 350)}\n`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'owner-targets.md'), `# V2 targets for the owner (write 50 queries; skip any you cannot describe)\n\n${owner.map(line).join('\n')}`);
fs.writeFileSync(path.join(outDir, 'agent-targets.md'), `# V2 targets\n\n${agent.map(line).join('\n')}`);
fs.writeFileSync(path.join(outDir, 'v2-targets.json'), JSON.stringify({ seed: 31, eligible: elig.length, owner: owner.map((d) => d.id), agent: agent.map((d) => d.id) }, null, 1));
if (process.env.EXTRA) { const ex = [...nodeAll.slice(70, 100), ...tsAll.slice(70, 100)]; s = 33 >>> 0; const exs = shuf(ex); fs.writeFileSync(path.join(outDir, 'extra-targets.md'), `# V2 additional targets\n\n${exs.map(line).join('\n')}`); fs.writeFileSync(path.join(outDir, 'v2-extra-targets.json'), JSON.stringify({ seed: 33, ids: exs.map((d) => d.id) }, null, 1)); console.log('extra', exs.length); }
console.log(JSON.stringify({ poolB: pool.length, eligible: elig.length, eligNode: elig.filter((d) => d.part === 'node').length, eligTs: elig.filter((d) => d.part === 'tslib').length, owner: owner.length, agent: agent.length }));
