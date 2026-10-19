import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMMANDS, FLAGS } from '../src/cli/tool-commands.ts';
import type { Command } from '../src/cli/tool-commands.ts';
import { DEGRADED_CODES } from '../src/facts/degraded.ts';
import { RATING_FEATURES, RATING_VALUES } from '../src/host-client/index.ts';
import { TOOL_NAMES } from '../src/query/tools.ts';
import { checkRelativeLinks } from './adr.ts';

// The user documentation under docs/tutorials, docs/how-to, docs/reference and docs/explanation, and the README, are
// kept honest by this file (plan 03-34). The references are checked against the code tables (COMMANDS, FLAGS,
// TOOL_NAMES, DEGRADED_CODES, the diagnostics catalog, the rating lists), the guides against the commands they show, every
// page against the shape of its quadrant (Diataxis), and every page against the hygiene and honesty rules below.
// Pages are discovered by directory, so a page added later is checked the moment it exists.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DOC_DIRS = ['tutorials', 'how-to', 'reference', 'explanation'] as const;

/** The two files that may use the word "ratified" (plan 03-36 writes both). */
const RATIFIED_ALLOWED: ReadonlySet<string> = new Set(['README.md', 'docs/reference/alpha-limitations.md']);

const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

/** Markdown files of a documentation directory, as sorted repository-relative POSIX paths. */
function pagesIn(dir: string): string[] {
  const absolute = path.join(root, 'docs', dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `docs/${dir}/${name}`);
}

const pages = (dir: (typeof DOC_DIRS)[number]): string[] => pagesIn(dir);
const allPages = (): string[] => DOC_DIRS.flatMap((dir) => pagesIn(dir));
const userFiles = (): string[] => ['README.md', ...allPages()];
const guideFiles = (): string[] => ['README.md', ...pages('tutorials'), ...pages('how-to')];

/** The text with fenced code blocks emptied (line count kept), so prose rules do not read code. */
function withoutFences(text: string): string {
  let inside = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inside = !inside;
        return '';
      }
      return inside ? '' : line;
    })
    .join('\n');
}

interface Fence {
  readonly info: string;
  readonly body: string;
  /** 0-based line of the opening fence. */
  readonly line: number;
}

function fencesOf(text: string): Fence[] {
  const lines = text.split('\n');
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^\s*(```|~~~)\s*([A-Za-z0-9_-]*)\s*$/.exec(lines[i] ?? '');
    if (open === null) continue;
    const marker = open[1] ?? '```';
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[j] ?? '')) {
      body.push(lines[j] ?? '');
      j += 1;
    }
    out.push({ info: open[2] ?? '', body: body.join('\n'), line: i });
    i = j;
  }
  return out;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- platform wording (exported for plan 03-36)

/** A sentence ends at `.`, `!` or `?` followed by whitespace, or at a line, list-item or table-row boundary; a semicolon does not end it. */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const cells = line.trim().startsWith('|') ? line.split('|') : [line];
    for (const cell of cells) {
      for (const sentence of cell.split(/(?<=[.!?])\s+/)) {
        const trimmed = sentence.trim();
        if (trimmed !== '') out.push(trimmed);
      }
    }
  }
  return out;
}

const WINDOWS_WORDS = ['windows', 'powershell', 'win32', 'cmd.exe', 'command prompt'] as const;
const WINDOWS_QUALIFIERS = ['not supported', 'postponed', 'do not block', 'does not block', 'non-blocking', 'allowed to fail', 'planned after the alpha'] as const;
const SYSTEM_COUNTS = ['all three systems', 'all three operating systems', 'all three platforms', 'all three oses', 'three systems', 'on all three'] as const;

/**
 * The problems of one page against the alpha platform decision (Windows is not supported in the alpha; Linux and macOS
 * are): a sentence that names Windows, PowerShell, win32, cmd.exe or the command prompt without saying it is not
 * supported, postponed, non-blocking or planned after the alpha, and any count of "three systems".
 */
export function platformProblems(file: string, text: string): string[] {
  const problems: string[] = [];
  for (const sentence of sentencesOf(text)) {
    const lower = sentence.toLowerCase();
    if (WINDOWS_WORDS.some((word) => lower.includes(word)) && !WINDOWS_QUALIFIERS.some((qualifier) => lower.includes(qualifier))) {
      problems.push(`${file}: a sentence names Windows without saying it is not supported or postponed: ${sentence}`);
    }
  }
  const lowerText = text.toLowerCase();
  for (const count of SYSTEM_COUNTS) {
    if (lowerText.includes(count)) problems.push(`${file}: counts systems ("${count}"), but the alpha supports Linux and macOS only`);
  }
  return problems;
}

// ---------------------------------------------------------------- command lines in the guides

const SHELL_FENCES: ReadonlySet<string> = new Set(['sh', 'bash', 'shell', 'console', 'zsh']);
const COMMAND_PATTERN = /(?:^|\s)(?:node\s+\S*dist\/bin\/gsd-atlas\.js|gsd-atlas)(?=\s|$)(.*)$/;
const GENERIC_FLAGS: ReadonlySet<string> = new Set(['--version', '--help', '-v', '-h']);

export interface Invocation {
  readonly line: number;
  readonly text: string;
}

/**
 * Command lines of the CLI in a page: every line of a shell fence (`sh`, `bash`, `shell`, `console`, `zsh`) and every
 * inline code span of the prose. A bare `gsd-atlas` in prose is not an invocation, and `gsd-atlas-mcp` is another program.
 */
export function invocationsOf(text: string): Invocation[] {
  const out: Invocation[] = [];
  const lines = text.split('\n');
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const open = /^\s*(```|~~~)\s*([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (open !== null) {
      fence = fence === undefined ? (open[2] ?? '') : undefined;
      continue;
    }
    const candidates: string[] = [];
    if (fence !== undefined) {
      if (SHELL_FENCES.has(fence)) candidates.push(line.replace(/^\s*\$\s+/, ''));
    } else {
      for (const span of line.matchAll(/`([^`\n]+)`/g)) candidates.push(span[1] ?? '');
    }
    for (const candidate of candidates) {
      const match = COMMAND_PATTERN.exec(candidate);
      if (match === null) continue;
      const rest = (match[1] ?? '').split(/\s\|\s|&&|\|\||;|\s>\s|\s2>/)[0] ?? '';
      if (rest.trim() === '') continue;
      out.push({ line: i + 1, text: rest.trim() });
    }
  }
  return out;
}

/** Why a command line (the words after `gsd-atlas`) is not valid, or undefined. */
export function invocationProblem(rest: string): string | undefined {
  const tokens = rest.split(/\s+/);
  const first = tokens[0] ?? '';
  if (GENERIC_FLAGS.has(first)) return undefined;
  if (first.startsWith('<') || first.startsWith('[')) return undefined; // a placeholder, nothing to check
  const name = first === 'lang' ? `lang ${tokens[1] ?? ''}` : first;
  const command: Command | undefined = COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) return `unknown command "${name}"`;
  const after = tokens.slice(first === 'lang' ? 2 : 1);
  for (const token of after) {
    if (token === '--') break;
    if (!token.startsWith('--')) continue;
    const flag = token.slice(2).split('=')[0] ?? '';
    if (GENERIC_FLAGS.has(token)) continue;
    if (!(command.flags as readonly string[]).includes(flag)) return `"${command.name}" does not accept --${flag}`;
  }
  return undefined;
}

// ---------------------------------------------------------------- the cases

test('every command is documented', () => {
  const cli = read('docs/reference/cli.md');
  const missing = COMMANDS.filter((command) => {
    const heading = new RegExp(`^#{2,4}\\s+gsd-atlas\\s+${escapeRegExp(command.name)}\\s*$`, 'm');
    const cell = new RegExp(`^\\|\\s*\`${escapeRegExp(command.name)}\`\\s*\\|`, 'm');
    return !heading.test(cli) && !cell.test(cli);
  }).map((command) => command.name);
  assert.deepEqual(missing, [], `docs/reference/cli.md has no heading or table cell for the command(s): ${missing.join(', ')}`);
});

test('every flag is documented', () => {
  const cli = read('docs/reference/cli.md');
  const missing = Object.keys(FLAGS).filter((flag) => !new RegExp(`--${escapeRegExp(flag)}(?![A-Za-z0-9-])`).test(cli));
  assert.deepEqual(missing, [], `docs/reference/cli.md does not mention the flag(s): ${missing.map((flag) => `--${flag}`).join(', ')}`);
});

test('every tool is documented', () => {
  const mcp = read('docs/reference/mcp.md');
  const missing = TOOL_NAMES.filter((tool) => !mcp.includes(`\`${tool}\``));
  assert.deepEqual(missing, [], `docs/reference/mcp.md does not mention the tool(s): ${missing.join(', ')}`);
});

test('every degraded code is documented', () => {
  const mcp = read('docs/reference/mcp.md');
  const missing = DEGRADED_CODES.filter((code) => !new RegExp(`^\\|\\s*\`${code}\`\\s*\\|`, 'm').test(mcp));
  assert.deepEqual(missing, [], `the degraded-code table of docs/reference/mcp.md has no row for: ${missing.join(', ')}`);
});

test('every diagnostics data type is documented', () => {
  const catalog = JSON.parse(read('diagnostics/catalog.v1.json')) as { readonly types: ReadonlyArray<{ readonly id: string }> };
  const cli = read('docs/reference/cli.md');
  const missing = catalog.types.map((type) => type.id).filter((id) => !cli.includes(`\`${id}\``));
  assert.deepEqual(missing, [], `docs/reference/cli.md does not name the diagnostics data type(s): ${missing.join(', ')}`);
});

test('every rating feature and value is documented', () => {
  const cli = read('docs/reference/cli.md');
  const missing = [...RATING_FEATURES, ...RATING_VALUES].filter((name) => !cli.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `docs/reference/cli.md does not name the rating feature(s) or value(s): ${missing.join(', ')}`);
});

test('relative links resolve', () => {
  const broken = checkRelativeLinks(root, userFiles());
  assert.deepEqual(
    broken,
    [],
    `broken relative link(s): ${broken.map((each) => `${each.file} -> ${each.link} (${each.target})`).join('; ')}`,
  );
});

test('how-to commands are real', () => {
  const problems: string[] = [];
  for (const file of guideFiles()) {
    for (const invocation of invocationsOf(read(file))) {
      const problem = invocationProblem(invocation.text);
      if (problem !== undefined) problems.push(`${file}:${String(invocation.line)}: gsd-atlas ${invocation.text}: ${problem}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('page shape follows its quadrant', () => {
  const problems: string[] = [];
  for (const dir of DOC_DIRS) {
    for (const file of pages(dir)) {
      const text = read(file);
      const titles = withoutFences(text)
        .split('\n')
        .filter((line) => /^# \S/.test(line));
      if (titles.length !== 1) {
        problems.push(`${file}: expected exactly one H1, found ${String(titles.length)}`);
        continue;
      }
      const title = (titles[0] ?? '').slice(2);
      if (dir === 'how-to' && !title.startsWith('How to ')) problems.push(`${file}: a how-to title starts with "How to ": ${title}`);
      if (dir === 'explanation' && !title.startsWith('About ')) problems.push(`${file}: an explanation title starts with "About ": ${title}`);
      if (dir === 'reference' && (title.startsWith('How to ') || title.startsWith('About '))) {
        problems.push(`${file}: a reference title is neither a how-to nor an explanation title: ${title}`);
      }
      if (dir === 'tutorials') {
        if (!text.includes('In this tutorial we will')) problems.push(`${file}: a tutorial states its destination with "In this tutorial we will"`);
        if (/you will learn/i.test(text)) problems.push(`${file}: a tutorial never says "you will learn"`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

/** Requirement-id prefixes of the planning documents; an id such as `TSM-01` is planning vocabulary. */
const REQUIREMENT_PREFIXES = 'AGT|DSH|EMB|EVL|FND|HRD|HST|IDX|INT|LNG|MET|NET|OKF|QRY|REL|SDK|SEC|SKL|STO|SWF|TSM';

test('no planning vocabulary, issue numbers or ratification claims', () => {
  const rules: ReadonlyArray<readonly [string, RegExp]> = [
    ['a phase number', /\bPhase\s+\d/],
    ['a plan id', /\bplans?\s+0\d-\d\d\b/i],
    ['a decision id (D-nn)', /\bD-\d\d\b/],
    ['an open-question id (OQn)', /\bOQ\d\b/],
    ['a requirement id', new RegExp(`\\b(?:${REQUIREMENT_PREFIXES})-\\d\\d\\b`)],
    ['an issue or pull request number', /\b(?:issues?|pull requests?|PRs?)\s*#\d+/i],
    ['an issue or pull request link', /github\.com\/\S*\/(?:issues|pull)\/\d+/],
    ['a closing keyword with a number', /\b(?:fixes|closes|resolves)\s+#\d+/i],
  ];
  const problems: string[] = [];
  for (const file of userFiles()) {
    const text = read(file).replace(/\bADR\s?#\d+/gi, 'ADR-n');
    for (const [what, pattern] of rules) {
      const found = pattern.exec(text);
      if (found !== null) problems.push(`${file}: ${what}: ${found[0]}`);
    }
    if (!RATIFIED_ALLOWED.has(file)) {
      const found = /\bratif(?:ied|ication|y)\b/i.exec(text);
      if (found !== null) problems.push(`${file}: a statement about ratification (only README.md and docs/reference/alpha-limitations.md may make one): ${found[0]}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('no machine paths or secrets', () => {
  const home = os.homedir();
  const rules: ReadonlyArray<readonly [string, RegExp]> = [
    ['a macOS home path', /\/Users\/[A-Za-z0-9._-]+/],
    ['a Linux home path', /\/home\/[a-z][a-z0-9_-]*\//],
    ['a Windows home path', /[A-Za-z]:\\Users\\/],
    ['a temporary directory of a run', /\/private\/tmp|\/var\/folders/],
    ['a token', /\b(?:ghp|gho|ghs|ghu|github_pat|xox[abpr]|AKIA|sk-ant)[-_A-Za-z0-9]{16,}/],
    ['a bearer token', /Bearer\s+[A-Za-z0-9._~+/-]{20,}/],
    ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
  const problems: string[] = [];
  for (const file of userFiles()) {
    const text = read(file);
    for (const [what, pattern] of rules) {
      const found = pattern.exec(text);
      if (found !== null) problems.push(`${file}: ${what}: ${found[0]}`);
    }
    if (home.length > 4 && text.includes(home)) problems.push(`${file}: the home directory of the machine that runs this test`);
  }
  assert.deepEqual(problems, []);
});

const MARKER = /^<!--\s*verified-by:\s*(cli|test|code):\s*(.+?)\s*-->$/;

/** Why the evidence of a `verified-by` marker does not hold, or undefined. */
function evidenceProblem(kind: string, value: string): string | undefined {
  if (kind === 'cli') {
    const match = /^(?:node\s+\S*dist\/bin\/gsd-atlas\.js|gsd-atlas)\s+(.+)$/.exec(value);
    if (match === null) return `a cli marker names a gsd-atlas command: ${value}`;
    const problem = invocationProblem(match[1] ?? '');
    return problem === undefined ? undefined : `the cli command is not real: ${problem}`;
  }
  const target = (value.split(/\s+/)[0] ?? '').replace(/:\d+(?:-\d+)?$/, '');
  return existsSync(path.join(root, target)) ? undefined : `the ${kind} path does not exist: ${target}`;
}

test('json examples parse and name their evidence', () => {
  const problems: string[] = [];
  for (const file of userFiles()) {
    const text = read(file);
    const lines = text.split('\n');
    for (const fence of fencesOf(text)) {
      if (fence.info !== 'json') continue;
      const where = `${file}:${String(fence.line + 1)}`;
      try {
        JSON.parse(fence.body);
      } catch (error) {
        problems.push(`${where}: a json fence does not parse (${error instanceof Error ? error.message : String(error)}); an abbreviated shape belongs in a text fence`);
      }
      let previous = fence.line - 1;
      while (previous >= 0 && (lines[previous] ?? '').trim() === '') previous -= 1;
      const marker = MARKER.exec((lines[previous] ?? '').trim());
      if (marker === null) {
        problems.push(`${where}: the line before a json fence is a <!-- verified-by: cli|test|code: ... --> marker`);
        continue;
      }
      const problem = evidenceProblem(marker[1] ?? '', marker[2] ?? '');
      if (problem !== undefined) problems.push(`${where}: ${problem}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('tutorial names its replay', () => {
  const tutorials = pages('tutorials');
  assert.ok(tutorials.length > 0, 'there is a tutorial');
  const problems: string[] = [];
  for (const file of tutorials) {
    const marker = /<!--\s*replayed:\s*(\d{4}-\d{2}-\d{2})\s+at\s+([0-9a-f]{7,40})\s*-->/.exec(read(file));
    if (marker === null) {
      problems.push(`${file}: no <!-- replayed: <date> at <commit> --> marker`);
      continue;
    }
    // A shallow clone (the CI checkout) cannot show the commit; the form of the marker is still checked.
    let shallow = false;
    try {
      shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim() === 'true';
    } catch {
      shallow = true;
    }
    if (shallow) continue;
    try {
      execFileSync('git', ['cat-file', '-e', `${marker[2] ?? ''}^{commit}`], { cwd: root, stdio: 'ignore' });
    } catch {
      problems.push(`${file}: the replay commit ${marker[2] ?? ''} is not in this repository's history`);
    }
  }
  assert.deepEqual(problems, []);
});

test('platform wording follows the alpha decision', () => {
  const problems: string[] = [];
  for (const file of allPages()) problems.push(...platformProblems(file, read(file)));

  const cli = read('docs/reference/cli.md');
  if (!cli.includes('macOS or Linux (Windows is not supported in the alpha)')) {
    problems.push('docs/reference/cli.md: the Requirements line says "macOS or Linux (Windows is not supported in the alpha)"');
  }
  if (cli.includes('macOS, Linux or Windows')) problems.push('docs/reference/cli.md: still lists Windows as a supported system ("macOS, Linux or Windows")');

  const contribute = read('docs/how-to/contribute-a-change.md');
  for (const fragment of ['on Linux and macOS run the build', 'the Windows jobs run too but do not block (Windows is postponed past the alpha)']) {
    if (!contribute.includes(fragment)) problems.push(`docs/how-to/contribute-a-change.md: missing "${fragment}"`);
  }

  const tutorial = read('docs/tutorials/index-and-ask.md');
  const sentence = 'Windows is not supported in the alpha; Linux and macOS are.';
  const at = tutorial.indexOf(sentence);
  const clone = tutorial.indexOf('git clone');
  if (at === -1) problems.push(`docs/tutorials/index-and-ask.md: missing "${sentence}"`);
  else if (clone !== -1 && at > clone) problems.push(`docs/tutorials/index-and-ask.md: "${sentence}" comes after the first git clone`);
  if (!tutorial.includes('The commands below are for a POSIX shell.')) problems.push('docs/tutorials/index-and-ask.md: missing "The commands below are for a POSIX shell."');

  assert.deepEqual(problems, []);
});

/** The `description` of a skill's front matter: a double-quoted YAML string is a JSON string, anything else is taken as written. */
function skillDescription(text: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const line = (match?.[1] ?? '').split('\n').find((candidate) => candidate.startsWith('description:'));
  const value = (line ?? '').slice('description:'.length).trim();
  if (value.startsWith('"')) return JSON.parse(value) as string;
  return value;
}

test('skill catalog matches the skill files', () => {
  const folders = readdirSync(path.join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, 'skills', entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  assert.ok(folders.length > 0, 'the package ships at least one skill');
  const page = read('docs/how-to/install-the-skills.md');
  const problems: string[] = [];
  for (const folder of folders) {
    const description = skillDescription(read(`skills/${folder}/SKILL.md`));
    const first = description.split(/(?<=[.!?])\s+/)[0] ?? '';
    if (first === '') problems.push(`skills/${folder}/SKILL.md has no description`);
    else if (!page.includes(first)) problems.push(`docs/how-to/install-the-skills.md does not hold the first sentence of the ${folder} description: ${first}`);
    if (!page.includes(`\`${folder}\``)) problems.push(`docs/how-to/install-the-skills.md does not name the skill \`${folder}\``);
  }
  if (!page.includes('gsd-atlas-eval:gsd-atlas')) problems.push('docs/how-to/install-the-skills.md does not name gsd-atlas-eval:gsd-atlas');
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------- the alpha statements (plan 03-36)
//
// The limitations page and the README make claims to the public about the project's own state: what the alpha does and
// does not do, which platforms it supports, whether the decision records are ratified, and what the registered evaluation
// found. The cases below check those claims against the files that establish them.

const LIMITATIONS = 'docs/reference/alpha-limitations.md';
const ANALYSIS = 'docs/eval/analysis.md';
const DIAGNOSIS = 'docs/eval/diagnosis.md';

/** The body of a level-2 section, heading excluded, up to the next level-2 heading; undefined when there is no such heading. */
function sectionOf(text: string, heading: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The body of a level-3 entry of a section, heading excluded, up to the next level-2 or level-3 heading. */
function entryOf(section: string, heading: string): string | undefined {
  const lines = section.split('\n');
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{2,3} \S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

type Verdict = 'MVP met' | 'MVP not met' | 'INCOMPLETE';

/** The registered verdict: the `OVERALL` line of the committed analysis, `none` when no analysis is committed. */
function registeredVerdict(): Verdict | 'none' | 'unreadable' {
  if (!existsSync(path.join(root, ANALYSIS))) return 'none';
  const line = /^OVERALL:\s*(.+?)\s*$/m.exec(read(ANALYSIS))?.[1];
  return line === 'MVP met' || line === 'MVP not met' || line === 'INCOMPLETE' ? line : 'unreadable';
}

const NUMBER = /\d+(?:\.\d+)?%?/g;
const hasDigit = (text: string): boolean => /\d/.test(text);

/** The text of a markdown page with link targets removed, so file names and anchors do not count as prose. */
const withoutLinkTargets = (text: string): string => text.replace(/\]\([^)]*\)/g, ']');

test('eval status matches the registered analysis', () => {
  assert.ok(existsSync(path.join(root, LIMITATIONS)), `${LIMITATIONS} exists`);
  const section = sectionOf(read(LIMITATIONS), 'Evaluation status');
  assert.ok(section !== undefined, `${LIMITATIONS} has an "Evaluation status" section`);
  const prose = withoutLinkTargets(section);
  const verdict = registeredVerdict();
  const problems: string[] = [];
  const sentences = sentencesOf(prose).map((sentence) => sentence.toLowerCase());
  if (verdict === 'unreadable') problems.push(`${ANALYSIS} is committed but its OVERALL line is not MVP met, MVP not met or INCOMPLETE`);
  if (verdict === 'MVP met' || verdict === 'MVP not met') {
    const analysis = read(ANALYSIS);
    if (!section.includes(`OVERALL: ${verdict}`)) problems.push(`the section does not quote the registered line "OVERALL: ${verdict}"`);
    if (!section.includes('](../eval/analysis.md)')) problems.push('the section does not link ../eval/analysis.md');
    if (!section.includes('](../eval/preregistration.md)')) problems.push('the section does not link ../eval/preregistration.md');
    if (verdict === 'MVP not met' && existsSync(path.join(root, DIAGNOSIS)) && !section.includes('](../eval/diagnosis.md)')) {
      problems.push('the section does not link ../eval/diagnosis.md');
    }
    for (const number of prose.match(NUMBER) ?? []) {
      if (!analysis.includes(number)) problems.push(`the number ${number} is not in ${ANALYSIS}`);
    }
    const measured = sentences.filter(
      (sentence) => !hasDigit(sentence) && sentence.includes('gsd-atlas tools') && sentence.includes('gsd-atlas skill') && sentence.includes('grep arm') && sentence.includes('neither'),
    );
    if (measured.length !== 1) {
      problems.push('the section holds exactly one sentence without a digit saying the atlas arm had the gsd-atlas tools and the gsd-atlas skill and the grep arm had neither');
    }
    if (verdict === 'MVP not met') {
      const wanted: ReadonlyArray<readonly [string, string, string]> = [
        ['ACCURACY: non-inferior', 'the accuracy criterion was met', 'accuracy'],
        ['TOKENS: not fewer', 'the token criterion was not met', 'tokens'],
        ['CITATIONS: below threshold', 'the citation criterion was not met', 'citations'],
      ];
      for (const [line, sentence, name] of wanted) {
        if (!analysis.includes(line)) problems.push(`${ANALYSIS} no longer says "${line}": update the ${name} sentence and this case together`);
        else if (!sentences.some((each) => each.includes(sentence))) problems.push(`the section does not say, in those words, that ${sentence}`);
      }
    }
  } else {
    if (!section.includes('No scored evaluation result is committed')) problems.push('the section says "No scored evaluation result is committed"');
    if (!section.includes('](../eval/preregistration.md)')) problems.push('the section does not link ../eval/preregistration.md');
    if (section.includes('analysis.md')) problems.push('the section links an analysis that is not committed');
    if (hasDigit(prose)) problems.push('the section holds a digit, but no result is committed');
    if (!sentences.some((sentence) => sentence.includes('registered design') && sentence.includes('gsd-atlas tools') && sentence.includes('gsd-atlas skill'))) {
      problems.push('the section says only that the registered design gives the atlas arm the gsd-atlas tools and the gsd-atlas skill');
    }
  }
  assert.deepEqual(problems, []);
});

const EFFICACY_PHRASES = ['fewer tokens', 'fewer billable tokens', 'token savings', 'token reduction', 'non-inferior', 'beats grep', 'faster than grep', 'cheaper than grep'] as const;

test('no efficacy claim outside the eval status', () => {
  const verdict = registeredVerdict();
  const problems: string[] = [];
  for (const file of userFiles()) {
    let text = read(file);
    const section = file === LIMITATIONS ? sectionOf(text, 'Evaluation status') : undefined;
    // Inside the Evaluation status section a claim is allowed only when the registered verdict is MVP met.
    if (section !== undefined && verdict === 'MVP met') text = text.replace(section, '');
    const lower = text.toLowerCase();
    for (const phrase of EFFICACY_PHRASES) {
      if (lower.includes(phrase)) problems.push(`${file}: an efficacy claim ("${phrase}") that the registered analysis does not license here`);
    }
  }
  assert.deepEqual(problems, []);
});

test('decision records are called drafts', () => {
  const problems: string[] = [];
  const legend = read('docs/adr/README.md');
  if (!/^## Pre-release legend\s*$/m.test(legend)) problems.push('docs/adr/README.md has a "Pre-release legend" section');
  for (const name of readdirSync(path.join(root, 'docs', 'adr')).filter((each) => /^\d+-.*\.md$/.test(each))) {
    if (!/^> Pre-release note:/m.test(read(`docs/adr/${name}`))) problems.push(`docs/adr/${name} has no "Pre-release note:" line`);
  }
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['README.md', 'docs/adr/README.md'],
    [LIMITATIONS, '../adr/README.md'],
  ];
  for (const [file, link] of pairs) {
    if (!existsSync(path.join(root, file))) {
      problems.push(`${file} exists`);
      continue;
    }
    const text = read(file);
    const sentences = sentencesOf(withoutFences(text));
    if (!sentences.some((sentence) => /\bdrafts?\b/i.test(sentence) && /decision records/i.test(sentence))) {
      problems.push(`${file}: no sentence says that the decision records are drafts`);
    }
    if (!text.includes(`](${link}`)) problems.push(`${file}: no link to ${link}`);
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      if (lower.includes('ratif') && !/\b(?:not|no|none|nothing|never|neither)\b/.test(lower)) problems.push(`${file}: a ratification sentence without a negation: ${sentence}`);
      if (sentence.includes('Accepted') && !/older|draft/i.test(sentence)) problems.push(`${file}: "Accepted" without "older" or "draft": ${sentence}`);
    }
    for (const phrase of ['now accepted', 'are final', 'is final']) {
      if (text.toLowerCase().includes(phrase)) problems.push(`${file}: "${phrase}"`);
    }
  }
  assert.deepEqual(problems, []);
});

const PLATFORM_SENTENCES =
  'Windows is not supported in the alpha. gsd-atlas is built and tested on macOS and Linux. The Windows CI jobs run but are allowed to fail, and known Windows failures are listed in the project\'s planning notes. Windows support is planned after the alpha.';

test('limitations page states the platforms', () => {
  assert.ok(existsSync(path.join(root, LIMITATIONS)), `${LIMITATIONS} exists`);
  const page = read(LIMITATIONS);
  const problems: string[] = [...platformProblems(LIMITATIONS, page)];
  const supported = sectionOf(page, 'Supported');
  const available = sectionOf(page, 'Not available');
  if (supported === undefined) problems.push('the page has no "Supported" section');
  if (available === undefined) problems.push('the page has no "Not available" section');
  if (supported !== undefined) {
    const first = supported.split('\n').find((line) => line.trim() !== '');
    if ((first ?? '').trim() !== '### Platforms') problems.push('the "Supported" section begins with a level-3 "Platforms" entry');
    const entry = entryOf(supported, 'Platforms');
    if (entry === undefined || entry.replace(/\s+/g, ' ').trim() !== PLATFORM_SENTENCES) {
      problems.push('the "Platforms" entry holds exactly the four sentences of the alpha decision, word for word');
    }
  }
  if (available !== undefined) {
    const first = available.split('\n').find((line) => line.trim() !== '') ?? '';
    if (!first.includes('Windows') || !first.includes('(#platforms)')) problems.push('the "Not available" section names Windows first and points to the Platforms entry');
  }
  assert.deepEqual(problems, []);
});

test('feedback guides state what the commands do', () => {
  const problems: string[] = [];
  const holds = (file: string, fragments: readonly string[]): void => {
    const text = read(file);
    for (const fragment of fragments) if (!text.includes(fragment)) problems.push(`${file}: missing "${fragment}"`);
  };
  holds('docs/how-to/rate-an-answer.md', ['there is no MCP tool for it', 'rate up', '--feature', '--session']);
  holds('docs/how-to/report-a-bug.md',['--confirm-raw', 'bug --clear', 'never uploads', '--include', '--mode']);
  holds('docs/how-to/turn-diagnostics-on-and-off.md', ['diagnostics preview', 'Nothing is submitted in this release', 'diagnostics disable', 'diagnostics types']);
  const trust = read('docs/explanation/how-atlas-decides-what-to-trust.md');
  if (/^\s*\d+\.\s/m.test(withoutFences(trust))) problems.push('the trust explanation has numbered steps');
  if (!trust.includes('](../reference/alpha-limitations.md')) problems.push('the trust explanation does not link the alpha limitations');
  // Nothing in a guide or the explanation may describe a submission or an intake as something that exists.
  for (const file of ['docs/how-to/rate-an-answer.md', 'docs/how-to/report-a-bug.md', 'docs/how-to/turn-diagnostics-on-and-off.md', 'docs/explanation/how-atlas-decides-what-to-trust.md']) {
    for (const sentence of sentencesOf(withoutFences(read(file)))) {
      if (/\b(?:submit|submits|submitted|submission|intake|auto-submit)\b/i.test(sentence) && !/\b(?:not|no|never|nothing|none|cannot|neither)\b|do not exist|does not exist/i.test(sentence)) {
        problems.push(`${file}: a sentence about submission or intake without a negation: ${sentence}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every page is linked from the readme', () => {
  const readme = read('README.md');
  const missing = allPages().filter((page) => !readme.includes(`](${page}`));
  assert.deepEqual(missing, [], `README.md links no page for: ${missing.join(', ')}`);
});

test('readme is a front door', () => {
  const readme = read('README.md');
  const lines = readme.replace(/\n$/, '').split('\n').length;
  assert.ok(lines <= 70, `README.md has ${String(lines)} lines; the front door has at most 70`);
  assert.ok(/^## Developer quickstart\s*$/m.test(readme), 'README.md keeps the "Developer quickstart" heading');
  assert.ok(readme.includes(`](${LIMITATIONS}`), `README.md links ${LIMITATIONS}`);
  assert.deepEqual(checkRelativeLinks(root, ['README.md']), []);
});

test('readme names the supported platforms', () => {
  const readme = read('README.md');
  const problems: string[] = [...platformProblems('README.md', readme)];
  for (const fragment of ['on macOS and Linux (Windows is not supported in the alpha)', 'CI runs Node 24.16.0 and 26 on Linux and macOS']) {
    if (!readme.includes(fragment)) problems.push(`README.md: missing "${fragment}"`);
  }
  for (const fragment of ['macOS, Linux and Windows', 'on all three systems']) {
    if (readme.includes(fragment)) problems.push(`README.md: still says "${fragment}"`);
  }
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------- install and release statements (quick task 261018)
//
// Until the first alpha was published the documentation promised no registry release. The alpha is published on the npm
// `alpha` channel, so the pages now say how to install it. These cases pin the exact statements that are allowed and keep
// every other install command, version promise and release date out of the user documentation.

const ALPHA_INSTALL = 'npm install -g @opengsd/gsd-atlas@alpha';

/** Every `npm install ...` command in the code spans and shell fences of a page. */
function npmInstallCommands(text: string): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const open = /^\s*(```|~~~)\s*([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (open !== null) {
      fence = fence === undefined ? (open[2] ?? '') : undefined;
      continue;
    }
    const candidates = fence !== undefined ? (SHELL_FENCES.has(fence) ? [line.trim()] : []) : [...line.matchAll(/`([^`\n]+)`/g)].map((span) => span[1] ?? '');
    for (const candidate of candidates) if (/\bnpm\s+(?:install|i)\b/.test(candidate)) out.push(candidate.trim());
  }
  return out;
}

/** The npm install commands each page may hold. A page that is not listed holds none. */
const ALLOWED_INSTALL_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  'README.md': [ALPHA_INSTALL],
  [LIMITATIONS]: [ALPHA_INSTALL],
  'docs/reference/release-channels.md': [ALPHA_INSTALL, 'npm install -g @opengsd/gsd-atlas@next', 'npm install -g @opengsd/gsd-atlas'],
  'docs/how-to/release-an-alpha.md': [ALPHA_INSTALL, 'npm install @opengsd/gsd-atlas@alpha'],
};

test('install commands: only the npm commands for the published channels, and only where they are allowed', () => {
  const problems: string[] = [];
  for (const file of userFiles()) {
    const allowed = ALLOWED_INSTALL_COMMANDS[file] ?? [];
    for (const command of npmInstallCommands(read(file))) {
      if (!allowed.includes(command)) problems.push(`${file}: an npm install command that is not allowed here: ${command}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('readme and limitations state how to install the alpha, with no date for a stable release', () => {
  const readme = read('README.md');
  const problems: string[] = [];
  const sentence = 'To install the alpha from npm, run `npm install -g @opengsd/gsd-atlas@alpha`, then `gsd-atlas --version`.';
  if (!readme.includes(sentence)) problems.push(`README.md: missing "${sentence}"`);
  if (!readme.includes('No date for a stable release is promised.')) problems.push('README.md: missing "No date for a stable release is promised."');
  if (!readme.includes('](docs/reference/release-channels.md)')) problems.push('README.md: no link to the release channels reference');
  if (!readme.includes('To build from a clone instead, use `npm ci --ignore-scripts` and `npm run build`')) problems.push('README.md: the clone-and-build path is gone');

  const limitations = read(LIMITATIONS);
  const status = sectionOf(limitations, 'Status') ?? '';
  const bullets = status.split('\n').filter((line) => line.startsWith('- '));
  if (!bullets.some((line) => line.startsWith('- This release is an alpha. It is published on the `alpha` channel of npm as `@opengsd/gsd-atlas` and is installed with `npm install -g @opengsd/gsd-atlas@alpha`; building from a clone also works'))) {
    problems.push(`${LIMITATIONS}: the first Status bullet does not state the alpha channel and the install command`);
  }
  if (!bullets.includes('- No compatibility between builds, no release date and no stable release are promised.')) {
    problems.push(`${LIMITATIONS}: the Status section does not say "No compatibility between builds, no release date and no stable release are promised."`);
  }
  if (/package version is/i.test(limitations) || /registry release/i.test(limitations)) problems.push(`${LIMITATIONS}: still states a package version or a registry release`);
  assert.deepEqual(problems, []);
});

test('no page promises a date or a stable release, and a version shown as output is the package version', () => {
  const problems: string[] = [];
  const version = (JSON.parse(read('package.json')) as { version: string }).version;
  for (const file of userFiles()) {
    const text = read(file);
    for (const sentence of sentencesOf(withoutFences(text))) {
      if (/\b(?:coming soon|will be released|will ship|expected (?:in|by|on)|planned for (?:Q[1-4]|20\d\d))\b/i.test(sentence)) problems.push(`${file}: a release promise: ${sentence}`);
      if (/\b(?:stable release|release date)\b/i.test(sentence) && !/\b(?:no|not|never|nothing|without)\b/i.test(sentence)) problems.push(`${file}: a stable release or release date without a negation: ${sentence}`);
    }
  }
  const tutorial = read('docs/tutorials/index-and-ask.md');
  if (!tutorial.includes(`\ngsd-atlas ${version}\n`)) problems.push(`docs/tutorials/index-and-ask.md: the --version output is not "gsd-atlas ${version}"`);
  if (!tutorial.includes(`> @opengsd/gsd-atlas@${version} build`)) problems.push(`docs/tutorials/index-and-ask.md: the build banner does not name version ${version}`);
  assert.deepEqual(problems, []);
});

test('release pages: the channels in the reference are the ones the checker and the workflow know', () => {
  const page = read('docs/reference/release-channels.md');
  const problems: string[] = [];
  for (const row of ['| `alpha` | `X.Y.Z-alpha.N` | `alpha` |', '| `next` | `X.Y.Z-next.N` or `X.Y.Z-rc.N` | `next` |', '| `latest` | `X.Y.Z`, no prerelease part | `latest` |']) {
    if (!page.includes(row)) problems.push(`docs/reference/release-channels.md: missing the row ${row}`);
  }
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  if (!/^ {4}environment:\s*npm-publish\s*$/m.test(workflow)) problems.push('release.yml no longer uses the npm-publish environment');
  for (const file of ['docs/reference/release-channels.md', 'docs/how-to/release-an-alpha.md']) {
    if (!read(file).includes('npm-publish')) problems.push(`${file}: does not name the npm-publish environment`);
  }
  assert.deepEqual(problems, []);
});
