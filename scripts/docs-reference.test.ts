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
