/**
 * node scripts/cleanroom/scrub.ts --check <files and directories> [--deny-env NAME]... [--deny-only]
 *
 * The leak check of the clean-room replication (plan 03-39, T-03-399). Committed tables, the report and the
 * progress file hold ids, counts, tokens, statuses and booleans only: no home or temporary path, no email
 * address, no token-like string, no host name, no raw session text. `scrubText` rewrites the known directories
 * into placeholders; `findLeaks` reports what remains by rule and line number, and never echoes the matched text.
 *
 * `--deny-env NAME` reads the deny list from the named environment variable (the whole value and, for the form
 * `user@host`, both parts). The value is never printed. `--deny-only` checks nothing but the deny list and the
 * token-like and email rules, for the image files and the guide, which legitimately name container paths.
 *
 * Replication tooling: Node built-ins only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export interface Replacements {
  /** The run (results) directory, shown as `<run>`. */
  readonly run?: string;
  /** The work directory, shown as `<work>`. */
  readonly work?: string;
  /** The home directory, shown as `<home>`. */
  readonly home?: string;
  /** The temporary directory, shown as `<tmp>`. */
  readonly tmp?: string;
}

export interface Leak {
  readonly rule: string;
  /** 1-based line number. */
  readonly line: number;
}

export interface LeakOptions {
  /** Words that must not appear (case-insensitive), for example the Docker host name. */
  readonly deny: readonly string[];
  /** Check the deny list, token-like strings and email addresses only. */
  readonly denyOnly?: boolean;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces each known directory with its placeholder. The longest directory is replaced first, so
 * `/work/cleanroom-run` becomes `<run>` and not `<work>/cleanroom-run`; a directory only matches as a whole path
 * segment (`/work` does not match `/workspace`).
 */
export function scrubText(text: string, replacements: Replacements): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, token] of [
    ['run', '<run>'],
    ['work', '<work>'],
    ['home', '<home>'],
    ['tmp', '<tmp>'],
  ] as const) {
    const value = replacements[key];
    if (value !== undefined && value !== '') pairs.push([value.replace(/[\\/]+$/, ''), token]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [directory, token] of pairs) {
    out = out.replace(new RegExp(`${escapeRegExp(directory)}(?![A-Za-z0-9_-])`, 'g'), token);
  }
  return out;
}

const PATH_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['home-path', /(?<![A-Za-z0-9_.~-])\/(?:home|Users|private)\//],
  ['home-path', /(?<![A-Za-z0-9])[A-Za-z]:(?:\\|\/(?=Users|Windows|Program))/],
  ['temp-path', /(?<![A-Za-z0-9_.~-])\/(?:tmp|var\/folders|var\/tmp)\//],
];

const EMAIL_RULE: readonly [string, RegExp] = ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/];

const TOKEN_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['token', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['token', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['token', /\bAKIA[0-9A-Z]{16}\b/],
  ['token', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const RAW_TEXT_RULE: readonly [string, RegExp] = ['raw-session-text', /\btranscripts?\b/i];

/**
 * The leaks in a text, by rule and line. A 64-character hex hash is allowed (the committed tables hold registered
 * hashes). The report never carries the matched text.
 */
export function findLeaks(text: string, options: LeakOptions): Leak[] {
  const rules: Array<readonly [string, RegExp]> = [...TOKEN_RULES, EMAIL_RULE];
  if (options.denyOnly !== true) rules.push(...PATH_RULES, RAW_TEXT_RULE);
  const deny = options.deny.map((word) => word.trim().toLowerCase()).filter((word) => word !== '');
  const leaks: Leak[] = [];
  text.split('\n').forEach((line, index) => {
    const seen = new Set<string>();
    for (const [rule, pattern] of rules) {
      if (!seen.has(rule) && pattern.test(line)) {
        seen.add(rule);
        leaks.push({ rule, line: index + 1 });
      }
    }
    const lower = line.toLowerCase();
    if (deny.some((word) => lower.includes(word))) leaks.push({ rule: 'deny', line: index + 1 });
  });
  return leaks;
}

/** The deny terms of one environment variable value: the whole value and, for `user@host`, both parts. */
export function denyTerms(value: string): string[] {
  const terms = new Set<string>();
  const whole = value.trim();
  if (whole === '') return [];
  terms.add(whole);
  if (whole.includes('@')) for (const part of whole.split('@')) if (part.trim() !== '') terms.add(part.trim());
  return [...terms];
}

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function filesUnder(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    out.push(...filesUnder(path.join(target, entry.name)));
  }
  return out;
}

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const USAGE =
  'usage: node scripts/cleanroom/scrub.ts --check <files and directories> [--deny-env NAME]... [--deny-only]\n' +
  '\n' +
  'Reports home and temporary paths, email addresses, token-like strings, deny-list words and raw session text by file, line and\n' +
  'rule (never the matched text). Exit 0 when clean, 1 on a leak, 2 on a usage error.\n' +
  '--deny-env NAME reads the deny list from that environment variable (the value is never printed).\n' +
  '--deny-only checks the deny list, tokens and email addresses only.\n';

function parseCommandLine(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean' },
      'deny-env': { type: 'string', multiple: true },
      'deny-only': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: true,
  });
}

/** The command body with injectable output; returns the exit code. */
export function runCli(argv: string[], io: Io, env: Readonly<Record<string, string | undefined>> = process.env): number {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    io.err(`scrub: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help === true) {
    io.out(USAGE);
    return 0;
  }
  if (parsed.values.check !== true || parsed.positionals.length === 0) {
    io.err(`scrub: --check needs at least one file or directory\n${USAGE}`);
    return 2;
  }
  const deny: string[] = [];
  for (const name of parsed.values['deny-env'] ?? []) {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      io.err(`scrub: the deny-list variable ${name} is not set\n`);
      return 2;
    }
    deny.push(...denyTerms(value));
  }
  let leaked = 0;
  let scanned = 0;
  try {
    for (const target of parsed.positionals) {
      for (const file of filesUnder(target)) {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        const buffer = fs.readFileSync(file);
        if (buffer.includes(0)) continue;
        scanned += 1;
        for (const leak of findLeaks(buffer.toString('utf8'), { deny, denyOnly: parsed.values['deny-only'] === true })) {
          leaked += 1;
          io.out(`leak ${file}:${String(leak.line)} ${leak.rule}\n`);
        }
      }
    }
  } catch (error) {
    io.err(`scrub: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  io.out(leaked === 0 ? `scrub: clean (${String(scanned)} files)\n` : `scrub: ${String(leaked)} leaks in ${String(scanned)} files\n`);
  return leaked === 0 ? 0 : 1;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  process.exitCode = runCli(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
