/**
 * First-reader key audit of the angular pilot questions (UNSCORED, UNREGISTERED). For every question it compares
 * the oracle key with a whole-word `git grep` reading of the pinned clone, classifies every file only one of them
 * has, and renders `key-audit.md`. A second reader and the owner's review are still needed.
 *
 *   node scripts/angular-pilot/audit.ts --repo <clone> --dir docs/eval/angular-pilot [--notes <json>] [--draft <md>]
 *
 * `--notes` is a JSON object keyed by question id: { class, verdict, comment, evidence[] } written by the human
 * reader after reading the disputed files. Without notes every class is `unverified`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { classifyGrepOnlyFile, declaresTopLevel, finalDeclarer, heritageHits, importOrigin, lineKinds, namespaceMembers, type FileView, type GrepOnlyResult } from './audit-lib.ts';
import { isPilotSource } from './census.ts';
import { compareKeyToGrep } from './sample-keys.ts';
import { loadQuestions, type AnswerFile } from '../eval/questions.ts';

const ALIASES = { '@angular/': 'packages/' } as const;

export type AuditClass = 'consistent' | 'ambiguous-wording' | 'key-likely-incomplete' | 'key-likely-overinclusive' | 'unverified';
export interface Note {
  class: AuditClass;
  verdict: string;
  comment: string;
  evidence?: string[];
}

function git(repo: string, args: string[], ok: number[] = [0]): { status: number; out: string } {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 29 });
  if (r.status === null || !ok.includes(r.status)) throw new Error(`git ${args.join(' ')} failed`);
  return { status: r.status, out: r.stdout };
}

function grepHits(repo: string, name: string): Map<string, number[]> {
  const { out } = git(repo, ['grep', '-I', '-n', '-w', '-F', '-e', name], [0, 1]);
  const map = new Map<string, number[]>();
  for (const l of out.split('\n')) {
    const m = /^([^:]+):(\d+):/.exec(l);
    if (m === null) continue;
    const arr = map.get(m[1]!) ?? [];
    arr.push(Number(m[2]));
    map.set(m[1]!, arr);
  }
  return map;
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
const clip = (s: string, n = 110): string => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

interface Section {
  id: string;
  category: string;
  name: string;
  file: string;
  keyFiles: string[];
  grepFiles: string[];
  grepTree: number;
  inBoth: string[];
  keyOnly: { file: string; evidence: string }[];
  grepOnly: { file: string; result: GrepOnlyResult }[];
  itemChecks: { file: string; line: number; ok: boolean; text: string }[];
  extra: string[];
}

function main(): void {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, dir: { type: 'string' }, notes: { type: 'string' }, draft: { type: 'string' }, preface: { type: 'string' }, title: { type: 'string' }, intro: { type: 'string' } } });
  if (values.repo === undefined || values.dir === undefined) throw new Error('usage: --repo <clone> --dir <dir> [--notes json] [--draft md]');
  const repo = values.repo;
  const dir = values.dir;
  const qs = loadQuestions(path.join(dir, 'pilot-questions.json'));
  const answers = JSON.parse(fs.readFileSync(path.join(dir, 'pilot-answers.json'), 'utf8')) as AnswerFile;
  const notes: Record<string, Note> = values.notes === undefined ? {} : (JSON.parse(fs.readFileSync(values.notes, 'utf8')) as Record<string, Note>);
  const tracked = new Set(git(repo, ['ls-files']).out.split('\n').filter((l) => l !== ''));
  const cache = new Map<string, string | undefined>();
  const view: FileView = {
    read: (rel) => {
      if (!cache.has(rel)) cache.set(rel, tracked.has(rel) ? fs.readFileSync(path.join(repo, rel), 'utf8') : undefined);
      return cache.get(rel);
    },
    exists: (rel) => tracked.has(rel),
  };
  const inScope = (r: string): boolean => isPilotSource(r, { tests: true });
  const sections: Section[] = [];

  for (const q of qs.questions) {
    const a = answers.answers.find((x) => x.questionId === q.id)!;
    const key = q.key;
    if (key.kind === 'abstain') {
      const name = 'symbol' in key.probe ? key.probe.symbol : '';
      const hits = grepHits(repo, name);
      const ci = git(repo, ['grep', '-I', '-i', '-l', '-F', '-e', name], [0, 1]).out.split('\n').filter((l) => l !== '');
      sections.push({ id: q.id, category: q.category, name, file: '(none)', keyFiles: [], grepFiles: [], grepTree: hits.size, inBoth: [], keyOnly: [], grepOnly: [], itemChecks: [], extra: [`case-insensitive substring matches in the tree: ${String(ci.length)}`] });
      continue;
    }
    if (!('symbol' in key)) throw new Error(`question ${q.id} has no symbol`);
    const name = key.symbol;
    const targetFile = ('definedIn' in key ? key.definedIn : undefined) ?? '';
    const hits = grepHits(repo, name);
    const grepFiles = uniq([...hits.keys()].filter(inScope));
    const keyFiles = uniq(a.items.map((i) => i.file ?? ''));
    const extra: string[] = [];
    let compareKey = keyFiles;
    let compareGrep = grepFiles;
    if (key.kind === 'definition') {
      const item = a.items[0]!;
      const declText = view.read(item.file!)!.split('\n')[(item.line ?? 1) - 1] ?? '';
      extra.push(`declaration line ${item.file}:${String(item.line)}: \`${clip(declText.trim())}\``);
      const useRef = /`([^`]+)`, line (\d+)/.exec(q.text);
      if (useRef !== null) {
        const useFile = useRef[1]!;
        const useLine = Number(useRef[2]);
        const useText = view.read(useFile)?.split('\n')[useLine - 1] ?? '';
        const origin = importOrigin(view.read(useFile) ?? '', useFile, name, view, ALIASES);
        extra.push(`use site ${useFile}:${String(useLine)}: \`${clip(useText.trim())}\`; import chain of that file ends at ${origin?.declarer ?? '(no import of the name)'}`);
      }
      const decls = grepFiles.filter((f) => declaresTopLevel(view.read(f) ?? '', name));
      extra.push(`files declaring a top-level \`${name}\` in scope: ${decls.join(', ')}`);
      compareKey = [];
      compareGrep = [];
    }
    if (key.kind === 'heritage') {
      const names = [name];
      const found: string[] = [];
      for (const f of grepFiles) {
        const text = view.read(f) ?? '';
        const origin = f === targetFile ? { alias: name, declarer: targetFile } : importOrigin(text, f, name, view, ALIASES);
        const own = f !== targetFile && declaresTopLevel(text, name);
        const viaTarget = origin?.declarer === targetFile;
        const nsTarget = namespaceMembers(text, f, name, view, ALIASES).some((m) => m.declarer === targetFile);
        if (!viaTarget && !nsTarget && (own || f !== targetFile)) continue;
        const aliases = origin === undefined ? names : [...names, origin.alias];
        for (const h of heritageHits(text, aliases)) found.push(`${f}:${h.cls}`);
      }
      const keyed = a.items.map((i) => `${i.file}:${i.symbol}`);
      const both = uniq(keyed.filter((k) => found.includes(k)));
      extra.push(`independent text reading of extends/implements clauses finds ${String(uniq(found).length)} class(es); the key has ${String(uniq(keyed).length)}`);
      extra.push(`in both: ${String(both.length)}; key only: ${uniq(keyed.filter((k) => !found.includes(k))).join(', ') || 'none'}; reading only: ${uniq(found.filter((k) => !keyed.includes(k))).join(', ') || 'none'}`);
    }
    const cmp = compareKeyToGrep(compareKey, compareGrep);
    const keyOnly = cmp.keyOnly.map((f) => {
      const item = a.items.find((i) => i.file === f);
      const text = item?.line === undefined ? '' : (view.read(f)?.split('\n')[item.line - 1] ?? '').trim();
      return { file: f, evidence: `${f}:${String(item?.line ?? '?')} \`${clip(text)}\`` };
    });
    const grepOnly = cmp.grepOnly.map((f) => ({ file: f, result: classifyGrepOnlyFile({ file: f, text: view.read(f) ?? '', name, targetFile, view, aliases: ALIASES }) }));
    const itemChecks = (key.kind === 'callers' || key.kind === 'references' ? a.items : []).map((i) => {
      const text = (view.read(i.file ?? '')?.split('\n')[(i.line ?? 1) - 1] ?? '').trim();
      const needles = a.needles;
      const code = needles.some((n) => lineKinds(text, n).some((k) => k.kind === 'code' || k.kind === 'member'));
      const call = key.kind !== 'callers' || needles.some((n) => new RegExp(`(?:new\\s+|@)?(?<![\\w$])${n.replace(/\$/g, '\\$')}\\s*(?:<[^()]*>)?\\s*(?:\\(|\`)`).test(text) || new RegExp(`@${n}`).test(text));
      return { file: i.file ?? '', line: i.line ?? 0, ok: code && call, text: clip(text) };
    });
    sections.push({ id: q.id, category: q.category, name, file: targetFile, keyFiles, grepFiles, grepTree: hits.size, inBoth: cmp.inBoth, keyOnly, grepOnly, itemChecks, extra });
  }

  const lines: string[] = [];
  const classes = (id: string): AuditClass => notes[id]?.class ?? 'unverified';
  const counts: Record<string, number> = {};
  for (const s of sections) counts[classes(s.id)] = (counts[classes(s.id)] ?? 0) + 1;
  lines.push(values.title ?? '# First-reader key audit of the 16 angular pilot questions', '');
  lines.push(values.intro !== undefined ? fs.readFileSync(values.intro, 'utf8').trimEnd() : '**Unscored, unregistered, first reader only.** Written by the agent that built the oracle; a second reader (a different agent) and the owner\'s review of the 16 questions are still pending. Nothing here is a registered key; the registered verdict `OVERALL: MVP not met` stands.', '');
  if (values.intro === undefined) lines.push('Generated by `node scripts/angular-pilot/audit.ts` from `pilot-questions.json`, `pilot-answers.json` and `audit-notes.json` (the human reader\'s classification and verdicts); the grep side uses `git grep -I -n -w -F` over the whole tree of the pinned clone (`3cc1edf3210a9debb0be57a4e99e53a54505db32`), restricted to the pilot scope (tracked `.ts` under `packages/`, spec and test files in, `.d.ts`, `schematics/`, `examples/`, `integrationtest/` out). The classification of grep-only files is text level (comments, strings, import and re-export lines, own declarations, import chains followed through `export *` and renaming re-exports) and does not use the TypeScript checker; the first reader looked at the first matching line of every `manual` file and read in full the files behind each discrepancy (key-only files, heritage differences, template-literal and regex-literal hits); `refers-to-target` files are mostly type-position uses and were not read one by one.', '');
  lines.push(`Classes: ${Object.entries(counts).map(([k, v]) => `${k} ${String(v)}`).join(', ')}.`, '');
  if (values.preface !== undefined) lines.push(fs.readFileSync(values.preface, 'utf8').trimEnd(), '');
  lines.push('## Summary table', '');
  lines.push('| id | category | symbol | key files | grep files (scope) | in both | key only | grep only | class | verdict |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const s of sections) {
    const kf = s.category === 'definition' ? 1 : s.keyFiles.length;
    lines.push(`| ${s.id} | ${s.category} | \`${s.name}\` | ${String(kf)} | ${String(s.grepFiles.length)} | ${String(s.inBoth.length)} | ${String(s.keyOnly.length)} | ${String(s.grepOnly.length)} | ${classes(s.id)} | ${notes[s.id]?.verdict ?? 'pending'} |`);
  }
  lines.push('', '## Evidence per question', '');
  for (const s of sections) {
    const n = notes[s.id];
    lines.push(`### ${s.id} ${s.category} \`${s.name}\` (${s.file})`, '');
    lines.push(`- Class: **${classes(s.id)}**. Verdict: ${n?.verdict ?? 'pending'}.`);
    if (n?.comment !== undefined) lines.push(`- Reading: ${n.comment}`);
    lines.push(`- Grep: \`git grep -I -n -w -F -e ${s.name}\` finds ${String(s.grepTree)} file(s) in the whole tree, ${String(s.grepFiles.length)} in scope. Key: ${String(s.keyFiles.length)} file(s).`);
    for (const e of s.extra) lines.push(`- ${e}`);
    for (const e of n?.evidence ?? []) lines.push(`- ${e}`);
    if (s.keyOnly.length > 0) {
      lines.push('- Key files with no whole-word hit (alias uses):');
      for (const k of s.keyOnly) lines.push(`  - ${k.evidence}`);
    }
    const bad = s.itemChecks.filter((c) => !c.ok);
    if (s.itemChecks.length > 0) lines.push(`- Key items checked at their line: ${String(s.itemChecks.length - bad.length)} of ${String(s.itemChecks.length)} show the name (or an alias) in code${s.category === 'callers' ? ' in call position' : ''}.`);
    for (const c of bad) lines.push(`  - CHECK ${c.file}:${String(c.line)} \`${c.text}\``);
    if (s.grepOnly.length > 0) {
      const byClass = new Map<string, number>();
      for (const g of s.grepOnly) byClass.set(g.result.klass, (byClass.get(g.result.klass) ?? 0) + 1);
      lines.push(`- Grep-only files (${String(s.grepOnly.length)}): ${[...byClass.entries()].map(([k, v]) => `${k} ${String(v)}`).join(', ')}.`);
      lines.push('', '  | file | class | first matching line |', '  | --- | --- | --- |');
      for (const g of s.grepOnly) {
        const first = g.result.lines.find((l) => l.kind === 'code' || l.kind === 'member' || l.kind === 'key') ?? g.result.lines[0];
        lines.push(`  | \`${g.file}\` | ${g.result.klass}${g.result.klass === 'different-symbol' || g.result.klass === 'refers-to-target' ? ` (${g.result.note})` : ''} | ${first === undefined ? '' : `${String(first.line)}: \`${clip(first.text, 90).replace(/\|/g, '\\|')}\``} |`);
      }
    }
    lines.push('');
  }
  fs.writeFileSync(values.draft ?? path.join(dir, 'key-audit.md'), `${lines.join('\n')}\n`);
  process.stdout.write(`audited ${String(sections.length)} questions: ${JSON.stringify(counts)}\n`);
  void finalDeclarer;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
