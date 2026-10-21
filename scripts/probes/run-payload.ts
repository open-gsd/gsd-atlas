/**
 * node scripts/probes/run-payload.ts --streams <dir> --out <file> [--arm atlas]
 * Offline P4 analysis of atlas tool-result sizes in a directory of raw streams (read-only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { summarize } from './payload.ts';

const { values } = parseArgs({ options: { streams: { type: 'string' }, out: { type: 'string' }, arm: { type: 'string', default: 'atlas' } } });
if (values.streams === undefined || values.out === undefined) throw new Error('--streams and --out are required');
const files = fs.readdirSync(values.streams).filter((f) => f.includes(`.${String(values.arm)}.`) && f.endsWith('.jsonl')).sort();
const texts = files.map((f) => fs.readFileSync(path.join(values.streams as string, f), 'utf8'));
const thresholds = [2048, 4096, 8192, 16384, 32768];
const summary = summarize(texts, thresholds);
const atlasTools = Object.entries(summary.byTool).filter(([t]) => t.startsWith('mcp__gsd-atlas__'));
const atlasCarried = atlasTools.reduce((a, [, s]) => a + s.carriedTokens, 0);
fs.writeFileSync(
  values.out,
  `${JSON.stringify({ arm: values.arm, thresholds, ...summary, atlasCarriedTokens: atlasCarried, atlasCarriedShareOfSessionTokens: summary.sessionTokens === 0 ? 0 : atlasCarried / summary.sessionTokens }, null, 1)}\n`,
);
process.stdout.write(`${String(files.length)} sessions\n`);
