// Scores recorded atlas calls (run-atlas.ts output) against audited answer keys and prints a per-question table.
//
//   node scripts/design-probe/analyze.ts --records <rec.json> --answers <answers.json> --scope angular|gsd-core [--list]
import { readFileSync } from 'node:fs';
import { fileSetOfKey, scoreSets, type KeyItem } from './measure-lib.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

const records = JSON.parse(readFileSync(arg('records') ?? '', 'utf8')) as { records: Array<{ question: string; tool: string; bytes: number; tokens: number; untrustedBytes: number; citationBytes: number; dataBytes: number; hasMore: boolean; files: string[]; resultCount: number }> };
const answers = (JSON.parse(readFileSync(arg('answers') ?? '', 'utf8')) as { answers: Array<{ questionId: string; kind: string; granularity?: string; items: KeyItem[] }> }).answers;
const scope = arg('scope');

function inScope(path: string): boolean {
  if (scope !== 'angular') return true;
  return path.startsWith('packages/') && !path.endsWith('.d.ts') && !/(^|\/)(schematics|examples|integrationtest)\//.test(path);
}

const questions = [...new Set(records.records.map((r) => r.question))];
for (const id of questions) {
  const calls = records.records.filter((r) => r.question === id);
  const main = calls.filter((r) => r.tool !== 'code_find');
  const answer = answers.find((a) => a.questionId === id);
  const found = new Set(main.flatMap((r) => r.files).filter(inScope));
  const key = answer === undefined ? new Set<string>() : fileSetOfKey(answer.items, 'file');
  const score = scoreSets(found, key);
  const sum = (field: 'bytes' | 'tokens' | 'untrustedBytes' | 'citationBytes' | 'dataBytes'): number => calls.reduce((a, r) => a + r[field], 0);
  console.log(
    `${id} kind=${answer?.kind} calls=${calls.length} bytes=${sum('bytes')} tok~=${sum('tokens')} data=${sum('dataBytes')} cit=${sum('citationBytes')} untrusted=${sum('untrustedBytes')} lastHasMore=${calls[calls.length - 1]?.hasMore} key=${key.size} found=${found.size} matched=${score.matched} missing=${score.missing} extra=${score.extra} exact=${score.exact}`,
  );
  if (process.argv.includes('--list')) {
    console.log('  missing:', [...key].filter((k) => !found.has(k)).join(' '));
    console.log('  extra:', [...found].filter((k) => !key.has(k)).join(' '));
  }
}
