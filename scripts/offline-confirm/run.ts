// Runs the four offline measurements over recorded data and prints the result tables as Markdown.
// No model session, no network, no API key; reads recorded streams, writes nothing but the optional JSON.
//
//   node scripts/offline-confirm/run.ts --scratch <dir with the recorded runs> --dist <worktree>/dist [--json <out.json>]
//
// Populations (all recorded, read-only):
//   cleanroom-atlas  <scratch>/fetch-cleanroom/cleanroom-run/streams/*.atlas.*   the 225 atlas sessions of the replication
//   pilot-v2         <scratch>/ap3/run/out-pilot/streams/ang-A-*                 angular pilot v2, atlas arms (64 sessions)
//   calibration      the angular calibration streams of both pilot rounds, atlas arms
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { provenanceOf } from './citation.ts';
import { readListing, listBytes, perTool, bytesOfJson, calibratedTokens, byteQuarterTokens, utf8, trimSet, TRIMMED_INSTRUCTIONS, ONE_TOOL, ONE_TOOL_INSTRUCTIONS, P1_FIRST_REQUEST } from './footprint.ts';
import { summariseMerge } from './merge.ts';
import { summariseReads } from './reads.ts';
import { sizePage, summarisePages, median } from './stats.ts';
import { atlasTool, isAtlasCall, parseStream } from './stream.ts';
import type { Session } from './stream.ts';

function arg(name: string, required = true): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) {
    if (required) throw new Error(`missing --${name}`);
    return '';
  }
  return value;
}

function load(dir: string, keep: (file: string) => boolean): Session[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl') && keep(file))
    .sort()
    .map((file) => parseStream(file, readFileSync(join(dir, file), 'utf8')));
}

const fixed = (value: number, digits = 1): string => value.toFixed(digits);
const pct = (value: number): string => `${fixed(value * 100, 1)}%`;

const scratch = arg('scratch');
const dist = arg('dist');
const jsonOut = arg('json', false);

const populations: { name: string; sessions: Session[] }[] = [
  { name: 'cleanroom-atlas', sessions: load(join(scratch, 'fetch-cleanroom/cleanroom-run/streams'), (f) => f.includes('.atlas.')) },
  { name: 'pilot-v2 (A-reg, A-ts)', sessions: load(join(scratch, 'ap3/run/out-pilot/streams'), (f) => f.startsWith('ang-A-')) },
  {
    name: 'calibration (A-reg, A-ts; both rounds)',
    sessions: [
      ...load(join(scratch, 'angular-pilot-run/out-calibration/streams'), (f) => f.startsWith('cal-A-')),
      ...load(join(scratch, 'angular-pilot-run-v2/out-calibration/streams'), (f) => f.startsWith('cal-A-')),
    ],
  },
];
const everything = populations.flatMap((population) => population.sessions);
const out: Record<string, unknown> = {};
const lines: string[] = [];
const say = (text = ''): void => {
  lines.push(text);
};

// ---------------------------------------------------------------- populations
say('### Populations');
say();
say('| population | sessions | sessions with an atlas call | atlas calls |');
say('| --- | ---: | ---: | ---: |');
for (const population of [...populations, { name: 'all three', sessions: everything }]) {
  const calls = population.sessions.flatMap((s) => s.calls.filter(isAtlasCall));
  const called = population.sessions.filter((s) => s.calls.some(isAtlasCall)).length;
  say(`| ${population.name} | ${String(population.sessions.length)} | ${String(called)} | ${String(calls.length)} |`);
}

// ---------------------------------------------------------------- A
say();
say('### A. Compact re-render');
say();
const aRows: string[] = [];
const aOut: Record<string, unknown> = {};
for (const population of [...populations, { name: 'all three', sessions: everything }]) {
  const pages = population.sessions.flatMap((session) =>
    session.calls
      .filter(isAtlasCall)
      .map((call) => (call.result === null ? null : sizePage(call, call.result)))
      .filter((page) => page !== null),
  );
  const s = summarisePages(pages);
  aOut[population.name] = s;
  aRows.push(
    `| ${population.name} | ${String(s.pages)} | ${String(s.references)} | ${fixed(s.perRef.original, 0)} | ${fixed(s.perRef.compact, 0)} | ${fixed(s.perRef.lean, 0)} | ${fixed(s.perRef.leanNoCursor, 0)} | ${fixed(s.medianPerRef.original, 0)} | ${fixed(s.medianPerRef.compact, 0)} | ${fixed(s.medianPerRef.lean, 0)} | ${fixed(s.medianPerRef.leanNoCursor, 0)} | ${pct(s.cutCompact)} | ${pct(s.cutLean)} | ${String(s.positionsKeptPages)}/${String(s.pages)} |`,
  );
}
say('Bytes per reference (aggregate, then median over pages), original JSON against the compact page with the matched line and the lean page (no matched line), pages with at least one reference only.');
say();
say('| population | pages | references | orig B/ref | compact B/ref | lean B/ref | lean B/ref ex-cursor | median orig | median compact | median lean | median lean ex-cursor | cut (compact) | cut (lean) | positions round-trip |');
say('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
lines.push(...aRows);
out.A = aOut;

// per tool, all populations pooled
const perToolRows: string[] = [];
const allPages = everything.flatMap((session) =>
  session.calls
    .filter(isAtlasCall)
    .map((call) => (call.result === null ? null : sizePage(call, call.result)))
    .filter((page) => page !== null),
);
say();
say('Per tool, all three populations pooled (bytes; tokens by bytes/4):');
say();
say('| tool | pages | references | orig B/page | compact B/page | lean B/page | orig tok/page | compact tok/page | orig B/ref | compact B/ref | lean B/ref |');
say('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
const perToolOut: Record<string, unknown> = {};
for (const tool of ['code_find', 'code_refs', 'code_impact', 'code_context']) {
  const pages = allPages.filter((page) => page.tool === tool);
  if (pages.length === 0) {
    perToolRows.push(`| ${tool} | 0 | 0 | | | | | | | | |`);
    continue;
  }
  const s = summarisePages(pages);
  perToolOut[tool] = s;
  perToolRows.push(
    `| ${tool} | ${String(s.pages)} | ${String(s.references)} | ${fixed(s.perPage.original, 0)} | ${fixed(s.perPage.compact, 0)} | ${fixed(s.perPage.lean, 0)} | ${fixed(s.perPage.original / 4, 0)} | ${fixed(s.perPage.compact / 4, 0)} | ${fixed(s.perRef.original, 0)} | ${fixed(s.perRef.compact, 0)} | ${fixed(s.perRef.lean, 0)} |`,
  );
}
lines.push(...perToolRows);
out.A_perTool = perToolOut;

// pages with 8 references (the design note's typical default page)
const eight = allPages.filter((page) => page.references === 8);
if (eight.length > 0) {
  const s = summarisePages(eight);
  say();
  say(
    `Pages with exactly 8 references (n=${String(eight.length)}): original ${fixed(s.perPage.original, 0)} B (${fixed(s.perPage.original / 4, 0)} tok), compact ${fixed(s.perPage.compact, 0)} B (${fixed(s.perPage.compact / 4, 0)} tok), lean ${fixed(s.perPage.lean, 0)} B.`,
  );
  out.A_eight = s;
}

// Composition of the originals, to check the design note's 22/36/30/12 split
let dataB = 0;
let citationB = 0;
let untrustedB = 0;
let totalB = 0;
for (const session of everything) {
  for (const call of session.calls.filter(isAtlasCall)) {
    if (call.result === null) continue;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(call.result) as Record<string, unknown>;
    } catch {
      continue;
    }
    dataB += bytesOfJson(envelope.data ?? null);
    citationB += bytesOfJson(envelope.citations ?? null);
    untrustedB += bytesOfJson(envelope.untrusted_text ?? null);
    totalB += utf8(call.result);
  }
}
say();
say(
  `Composition of the original results (pooled, ${String(totalB)} B): data ${pct(dataB / totalB)}, citations ${pct(citationB / totalB)}, untrusted_text ${pct(untrustedB / totalB)}, envelope and the rest ${pct(1 - (dataB + citationB + untrustedB) / totalB)}.`,
);
out.A_composition = { totalB, dataB, citationB, untrustedB };

// design-probe records: sizes only
const dpDir = join(scratch, 'dp');
const dpRecords: { tool: string; bytes: number; resultCount: number }[] = [];
for (const file of ['rec-angular.json', 'rec-angular-big.json', 'rec-self.json']) {
  const path = join(dpDir, file);
  if (!existsSync(path)) continue;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { records: { tool: string; bytes: number; resultCount: number }[] };
  dpRecords.push(...parsed.records);
}
say();
say('Design-probe records (`dp/rec-*.json`) hold sizes and file lists, not the envelopes, so they cannot be re-rendered. Bytes per reference as recorded (pages with at least one result):');
say();
say('| tool | pages | results | bytes | B/result (aggregate) | B/result (median) |');
say('| --- | ---: | ---: | ---: | ---: | ---: |');
const dpOut: Record<string, unknown> = {};
for (const tool of ['code_find', 'code_refs', 'code_impact', 'code_context']) {
  const rows = dpRecords.filter((r) => r.tool === tool && r.resultCount > 0);
  if (rows.length === 0) continue;
  const bytes = rows.reduce((t, r) => t + r.bytes, 0);
  const results = rows.reduce((t, r) => t + r.resultCount, 0);
  dpOut[tool] = { pages: rows.length, results, bytes };
  say(`| ${tool} | ${String(rows.length)} | ${String(results)} | ${String(bytes)} | ${fixed(bytes / results, 0)} | ${fixed(median(rows.map((r) => r.bytes / r.resultCount)), 0)} |`);
}
out.A_designProbeRecords = dpOut;

// raw design-probe page
const rawPage = join(dpDir, 'refs1.json');
if (existsSync(rawPage)) {
  const raw = readFileSync(rawPage, 'utf8').trim();
  const size = sizePage(undefined, raw);
  if (size !== null) {
    say();
    say(`Raw design-probe page \`dp/refs1.json\` (code_refs, ${String(size.references)} references): original ${String(size.original)} B, compact ${String(size.compact)} B, lean ${String(size.lean)} B.`);
    out.A_refs1 = size;
  }
}

// citation provenance
say();
say('H3/N2 provenance: for sessions with an atlas call and a final answer, where the answer items that carry a line come from.');
say();
say('| population | sessions | items with a line | (file, line) is an atlas row | file is an atlas file, line differs | file not returned by atlas |');
say('| --- | ---: | ---: | ---: | ---: | ---: |');
const provOut: Record<string, unknown> = {};
for (const population of [...populations, { name: 'all three', sessions: everything }]) {
  let sessions = 0;
  let withLine = 0;
  let exact = 0;
  let fileOnly = 0;
  let none = 0;
  for (const session of population.sessions) {
    const p = provenanceOf(session);
    if (p === null) continue;
    sessions += 1;
    withLine += p.itemsWithLine;
    exact += p.exactFromAtlas;
    fileOnly += p.fileOnlyFromAtlas;
    none += p.notFromAtlas;
  }
  provOut[population.name] = { sessions, withLine, exact, fileOnly, none };
  say(`| ${population.name} | ${String(sessions)} | ${String(withLine)} | ${String(exact)} | ${String(fileOnly)} | ${String(none)} |`);
}
out.A_provenance = provOut;

// ---------------------------------------------------------------- B
say();
say('### B. Merge replay');
say();
say('| population | sessions | called | atlas calls | calls per called session | calls saved (strict) | of which `more` continuations | calls saved (loose bound) | called sessions with nothing to merge | called sessions with a saving |');
say('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
const bOut: Record<string, unknown> = {};
for (const population of [...populations, { name: 'all three', sessions: everything }]) {
  const s = summariseMerge(population.sessions);
  bOut[population.name] = { ...s, callsHistogram: [...s.callsHistogram], savedHistogram: [...s.savedHistogram] };
  say(
    `| ${population.name} | ${String(s.sessions)} | ${String(s.calledSessions)} | ${String(s.calls)} | ${fixed(s.meanCallsPerCalled, 2)} | ${String(s.strictSaved)} | ${String(s.continuationsSaved)} | ${String(s.looseSaved)} | ${String(s.calledNothingToMerge)} | ${String(s.sessionsWithStrictSaving)} |`,
  );
}
out.B = bOut;
say();
say('Distribution of mergeable atlas calls per called session (calls: sessions) and of strict savings (saved: sessions), all three populations:');
const all = summariseMerge(everything);
say();
say(`calls: ${[...all.callsHistogram].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${String(k)}: ${String(v)}`).join(', ')}`);
say(`saved: ${[...all.savedHistogram].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${String(k)}: ${String(v)}`).join(', ')}`);
const tools = new Map<string, number>();
for (const session of everything) for (const call of session.calls.filter(isAtlasCall)) tools.set(atlasTool(call), (tools.get(atlasTool(call)) ?? 0) + 1);
say(`atlas calls by tool (all three): ${[...tools].map(([k, v]) => `${k} ${String(v)}`).join(', ')}`);

// ---------------------------------------------------------------- C
say();
say('### C. Reads after atlas calls');
say();
say('| population | called sessions | with any Read, Grep or shell file read or grep after an atlas call | with any Read or shell file read after an atlas call | with the signal (Read or shell file read of a returned file within two turns) | signal incl. grep of a returned file |');
say('| --- | ---: | ---: | ---: | ---: | ---: |');
const cOut: Record<string, unknown> = {};
for (const population of [...populations, { name: 'all three', sessions: everything }]) {
  const s = summariseReads(population.sessions);
  cOut[population.name] = s;
  say(`| ${population.name} | ${String(s.calledSessions)} | ${String(s.sessionsAnyFollow)} | ${String(s.sessionsAnyReadAfter)} | ${String(s.sessionsSignal)} | ${String(s.sessionsSignalWithGrepFile)} |`);
}
out.C = cOut;
say();
say('Follow-up calls after the first atlas call, by category (all three populations): calls, those naming a file atlas had returned earlier in the session, and those within two assistant turns of the call that returned it.');
say();
say('| category | calls after an atlas call | target a returned file | ... within two turns |');
say('| --- | ---: | ---: | ---: |');
const allReads = summariseReads(everything);
for (const [category, row] of Object.entries(allReads.byCategory)) say(`| ${category} | ${String(row.after)} | ${String(row.returned)} | ${String(row.within)} |`);
const total = Object.values(allReads.byCategory).reduce((t, r) => ({ after: t.after + r.after, returned: t.returned + r.returned, within: t.within + r.within }), { after: 0, returned: 0, within: 0 });
say(`| all | ${String(total.after)} | ${String(total.returned)} | ${String(total.within)} |`);
say();
say('Cleanroom atlas population alone, by category:');
say();
say('| category | calls after an atlas call | target a returned file | ... within two turns |');
say('| --- | ---: | ---: | ---: |');
const crReads = summariseReads(populations[0]?.sessions ?? []);
for (const [category, row] of Object.entries(crReads.byCategory)) say(`| ${category} | ${String(row.after)} | ${String(row.returned)} | ${String(row.within)} |`);

// ---------------------------------------------------------------- D
say();
say('### D. First-request footprint');
say();
const env = {
  PATH: process.env.PATH,
  XDG_CACHE_HOME: join(scratch, 'oc-cache'),
  XDG_CONFIG_HOME: join(scratch, 'oc-config'),
} as NodeJS.ProcessEnv;
const listing = await readListing(join(dist, 'bin/gsd-atlas-mcp.js'), env);
const current = listBytes(listing.tools);
const instructions = utf8(listing.instructions);
const skillBytes = existsSync(join(dist, '../skills/gsd-atlas/SKILL.md')) ? utf8(readFileSync(join(dist, '../skills/gsd-atlas/SKILL.md'), 'utf8')) : 0;
const three = trimSet(listing.tools, ['code_find', 'code_refs', 'code_impact']);
const four = trimSet(listing.tools, ['code_find', 'code_refs', 'code_context', 'code_impact']);
const oneTool = [ONE_TOOL];
const sets: { name: string; tools: typeof listing.tools; instructions: string }[] = [
  { name: 'current: 7 tools', tools: listing.tools, instructions: listing.instructions },
  { name: 'trimmed A: find, refs, impact (3 tools, short text)', tools: three, instructions: TRIMMED_INSTRUCTIONS },
  { name: 'trimmed B: find, refs, context, impact (4 tools, short text)', tools: four, instructions: TRIMMED_INSTRUCTIONS },
  { name: 'one tool: atlas_explore (draft)', tools: oneTool, instructions: ONE_TOOL_INSTRUCTIONS },
];
const dOut: Record<string, unknown> = { perTool: perTool(listing.tools), skillBytes };
say('| surface | definitions B | bytes/4 tok | calibrated tok | instructions B | saving vs current (calibrated tok) | saving incl. instructions (bytes/4 tok for instructions) |');
say('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const set of sets) {
  const bytes = listBytes(set.tools);
  const ins = utf8(set.instructions);
  const saved = calibratedTokens(current) - calibratedTokens(bytes);
  const savedWithInstructions = saved + byteQuarterTokens(instructions) - byteQuarterTokens(ins);
  dOut[set.name] = { bytes, instructionsBytes: ins, calibrated: calibratedTokens(bytes), quarter: byteQuarterTokens(bytes), saved, savedWithInstructions };
  say(`| ${set.name} | ${String(bytes)} | ${String(byteQuarterTokens(bytes))} | ${String(calibratedTokens(bytes))} | ${String(ins)} | ${String(saved)} | ${String(savedWithInstructions)} |`);
}
say();
say(`Per tool (current, bytes): ${perTool(listing.tools).map((t) => `${t.name} ${String(t.bytes)}`).join(', ')}. Skill file: ${String(skillBytes)} B.`);
say();
const bytesOfNamed = (names: readonly string[]): number => listing.tools.filter((t) => names.includes(t.name)).reduce((total, t) => total + bytesOfJson(t), 0);
const p1Removed = bytesOfNamed(['code_context', 'code_explain', 'atlas_status', 'lang_list']);
const trimBRemoved = bytesOfNamed(['code_explain', 'atlas_status', 'lang_list']);
say(`Calibration check: P1 removed code_context, code_explain, atlas_status and lang_list and measured 1,422 fewer tokens; those four are ${String(p1Removed)} B, which the calibration puts at ${String(calibratedTokens(p1Removed))} tokens.`);
say(
  `Conservative saving, not relying on the calibration for the shortened text: tools removed (calibrated) plus the 258 tokens P2a measured for shortening the full set. Trimmed A: ${String(calibratedTokens(p1Removed) + 258)}. Trimmed B: ${String(calibratedTokens(trimBRemoved) + 258)}.`,
);
dOut.calibrationCheck = { p1RemovedBytes: p1Removed, calibrated: calibratedTokens(p1Removed), trimBRemovedBytes: trimBRemoved };
say();
say(`P1 first request: atlas ${String(P1_FIRST_REQUEST.atlas)}, grep ${String(P1_FIRST_REQUEST.grep)} tokens.`);
for (const set of sets.slice(1)) {
  const saved = (dOut[set.name] as { savedWithInstructions: number }).savedWithInstructions;
  const after = P1_FIRST_REQUEST.atlas - saved;
  say(`- ${set.name}: first request about ${String(after)} tokens (${fixed(after / P1_FIRST_REQUEST.grep, 2)} x grep), skill and Skill tool unchanged.`);
}
out.D = dOut;

process.stdout.write(`${lines.join('\n')}\n`);
if (jsonOut !== '') writeFileSync(jsonOut, `${JSON.stringify(out, null, 1)}\n`);
