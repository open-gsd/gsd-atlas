// The free-alternatives scan runner (EVL-01, D-05). Dev tooling for the eval: it must never import
// from src/ (D-02) and it is not an eval arm. One tool, one question set, one throwaway checkout of
// the pinned gsd-core commit, one headless `claude` session per question through the session runner.
//
//   node scripts/eval/scan.ts --tool <id> --corpus-dir <dir> --out docs/eval/scan-runs/<id>.json
//   node scripts/eval/scan.ts embed-keys --repo <dir> [--tsconfig tsconfig.json]
//
// The run file holds counts, ids and short gap notes only: no transcript, no repository text and no
// absolute path (threat T-03-63). Raw streams go to the scratch directory, outside the repository.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { billableTokens, runClaudeSession, type InitEvent, type SessionOutcome, type SessionSpec } from './claude-session.ts';
import {
  AnswerKeySchema,
  CategorySchema,
  KeySpecSchema,
  QuestionSchema,
  type AnswerKey,
  type Question,
} from './questions.ts';

// ---------------------------------------------------------------------------------------------
// Constants. Both limits are rows of .planning/phases/03-typescript-module-and-mvp-eval/
// 03-CONSTANTS.md (Status: Approved 2026-10-18); a test compares them with that file.

/** `scan.maxBudgetUsdPerSession`: the cost cap passed to every live session. */
export const SCAN_MAX_BUDGET_USD_PER_SESSION = 3;
/** `scan.sessionWallClockMs`: the wall-clock kill for every live session. */
export const SCAN_SESSION_WALL_CLOCK_MS = 900_000;
/** The same model alias for every tool; the model id the program reports is recorded in each file. */
export const SCAN_MODEL = 'sonnet';

/** Built-in tools of every scan session: reading and a shell restricted to read-only commands. */
export const SCAN_TOOLS: readonly string[] = ['Bash', 'Read'];

/** Identical for every tool (research Eval E: this Claude Code version has no Grep tool). */
export const SCAN_READ_ONLY_ALLOWED: readonly string[] = [
  'Read',
  'Bash(git grep:*)',
  'Bash(git ls-files:*)',
  'Bash(rg:*)',
  'Bash(grep:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
];

// ---------------------------------------------------------------------------------------------
// Question file

const SCAN_ID = /^s-\d{3}$/;

export const ScanQuestionSchema = z.strictObject({
  id: z.string().regex(SCAN_ID, 'must be s- followed by three digits'),
  category: CategorySchema,
  text: z.string().min(1),
  key: KeySpecSchema,
  /** The oracle's answer key for this question at the pinned commit, embedded so no live oracle run is needed. */
  expected: AnswerKeySchema,
});
export type ScanQuestion = z.infer<typeof ScanQuestionSchema>;

export const ScanQuestionFileSchema = z
  .strictObject({
    corpusId: z.string().min(1),
    corpusSha: z.string().min(1),
    oracleVersion: z.string().min(1),
    questions: z.array(ScanQuestionSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.questions.forEach((question, index) => {
      if (seen.has(question.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate id ${question.id}`, path: ['questions', index, 'id'] });
      }
      seen.add(question.id);
      const mapped = QuestionSchema.safeParse(scanQuestionToQuestionInput(question));
      if (!mapped.success) {
        ctx.addIssue({ code: 'custom', message: mapped.error.message, path: ['questions', index] });
      }
      if (question.expected.questionId !== question.id) {
        ctx.addIssue({ code: 'custom', message: 'expected.questionId must equal the question id', path: ['questions', index, 'expected'] });
      }
    });
  });
export type ScanQuestionFile = z.infer<typeof ScanQuestionFileSchema>;

function scanQuestionToQuestionInput(question: ScanQuestion): unknown {
  // The eval's Question schema wants q-<digits>; scan ids are s-<digits>, so the number carries over.
  return { id: `q-${Number(question.id.slice(2))}`, category: question.category, text: question.text, key: question.key };
}

/** The scan question as a plan 03-04 `Question` (id `s-007` becomes `q-7`), or throws the zod error. */
export function scanQuestionToQuestion(question: ScanQuestion): Question {
  return QuestionSchema.parse(scanQuestionToQuestionInput(question));
}

export function loadScanQuestions(file: string): ScanQuestionFile {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return ScanQuestionFileSchema.parse(JSON.parse(text));
}

// ---------------------------------------------------------------------------------------------
// Run file

const nonNegInt = z.number().int().nonnegative();

const TokensSchema = z.strictObject({
  input: nonNegInt,
  output: nonNegInt,
  cacheCreation: nonNegInt,
  cacheRead: nonNegInt,
  billable: nonNegInt,
});

export const ScanRowSchema = z.strictObject({
  questionId: z.string().regex(SCAN_ID),
  category: CategorySchema,
  status: z.enum(['ok', 'error', 'timeout', 'budget', 'killed']),
  correct: z.enum(['yes', 'partial', 'no']),
  tokens: TokensSchema,
  toolCalls: nonNegInt,
  toolCallsByName: z.record(z.string(), nonNegInt),
  /** The tool names of the session's init event: what the session could use. */
  initTools: z.array(z.string()),
  mcpServers: z.array(z.strictObject({ name: z.string(), status: z.string() })),
  wallMs: nonNegInt,
  costUsd: z.number().nonnegative(),
  numTurns: nonNegInt,
  answer: z.strictObject({
    parsed: z.boolean(),
    abstain: z.boolean(),
    itemCount: nonNegInt,
    matched: nonNegInt,
    expected: nonNegInt,
    extra: nonNegInt,
  }),
  gapNote: z.string(),
});
export type ScanRow = z.infer<typeof ScanRowSchema>;

export const ScanRunFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tool: z.strictObject({
    id: z.string().min(1),
    label: z.string().min(1),
    version: z.string().min(1),
    installMethod: z.string().min(1),
  }),
  claudeCodeVersion: z.string(),
  model: z.string(),
  date: z.string().min(1),
  corpus: z.strictObject({ id: z.string().min(1), sha: z.string().min(1) }),
  limits: z.strictObject({ maxBudgetUsdPerSession: z.number().positive(), sessionWallClockMs: nonNegInt }),
  isolation: z.strictObject({
    settingSources: z.literal(''),
    strictMcpConfig: z.literal(true),
    tools: z.array(z.string()),
    allowedTools: z.array(z.string()),
  }),
  couldNotRun: z.strictObject({ reason: z.string().min(1) }).nullable(),
  rows: z.array(ScanRowSchema),
  totals: z.strictObject({
    sessions: nonNegInt,
    yes: nonNegInt,
    partial: nonNegInt,
    no: nonNegInt,
    tokens: TokensSchema,
    toolCalls: nonNegInt,
    wallMs: nonNegInt,
    costUsd: z.number().nonnegative(),
  }),
});
export type ScanRunFile = z.infer<typeof ScanRunFileSchema>;

export function loadScanRun(file: string): ScanRunFile {
  return ScanRunFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// ---------------------------------------------------------------------------------------------
// Answers

const AnswerObjectSchema = z.object({
  abstain: z.boolean().optional().default(false),
  items: z.array(
    z.object({
      file: z.string().min(1),
      line: z.number().int().positive().optional().catch(undefined),
      symbol: z.string().min(1).optional().catch(undefined),
    }),
  ),
});

export interface AnswerItemInput {
  file: string;
  line?: number;
  symbol?: string;
}
export interface ParsedAnswer {
  abstain: boolean;
  items: AnswerItemInput[];
}

function normalizeFile(raw: string, corpusDir?: string): string {
  let file = raw.trim().replace(/\\/g, '/');
  const prefixes: string[] = [];
  if (corpusDir !== undefined) {
    prefixes.push(corpusDir.replace(/\\/g, '/'));
    try {
      prefixes.push(fs.realpathSync.native(corpusDir).replace(/\\/g, '/'));
    } catch {
      // The directory may not exist (a unit test); the plain prefix is enough then.
    }
  }
  for (const prefix of prefixes) {
    const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (file.startsWith(withSlash)) {
      file = file.slice(withSlash.length);
      break;
    }
  }
  while (file.startsWith('./')) file = file.slice(2);
  const withLine = /^(.+\.[A-Za-z0-9]+):\d+(?:-\d+)?$/.exec(file);
  if (withLine !== null) file = withLine[1];
  return file;
}

/** Balanced top-level `{...}` spans of a text, string-literal aware, with their start offsets. */
function objectSpans(text: string): { start: number; body: string }[] {
  const spans: { start: number; body: string }[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) spans.push({ start, body: text.slice(start, i + 1) });
    }
  }
  return spans;
}

/**
 * The model's final answer: the last JSON object in the text that has an `items` array of
 * `{file, line?, symbol?}`. Fenced and bare objects are both read. Null when none is present.
 */
export function parseAnswer(text: string, corpusDir?: string): ParsedAnswer | null {
  const candidates: { start: number; body: string }[] = [];
  for (const match of text.matchAll(/```(?:json)?[^\n]*\n([\s\S]*?)```/g)) {
    candidates.push({ start: match.index ?? 0, body: match[1] });
  }
  candidates.push(...objectSpans(text));
  candidates.sort((a, b) => b.start - a.start);
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate.body.trim());
    } catch {
      continue;
    }
    const parsed = AnswerObjectSchema.safeParse(value);
    if (!parsed.success) continue;
    const items: AnswerItemInput[] = parsed.data.items.map((item) => {
      const out: AnswerItemInput = { file: normalizeFile(item.file, corpusDir) };
      if (item.line !== undefined) out.line = item.line;
      if (item.symbol !== undefined) out.symbol = item.symbol;
      return out;
    });
    return { abstain: parsed.data.abstain, items };
  }
  return null;
}

export interface Comparison {
  correct: 'yes' | 'partial' | 'no';
  matched: number;
  expected: number;
  extra: number;
}

function keyUnits(expected: AnswerKey): Set<string> {
  const units = new Set<string>();
  for (const item of expected.items) {
    if (item.file === undefined) continue;
    units.add(expected.granularity === 'file' ? item.file : `${item.file}#${item.symbol ?? ''}`);
  }
  return units;
}

function answerUnits(expected: AnswerKey, answer: ParsedAnswer): Set<string> {
  const units = new Set<string>();
  for (const item of answer.items) {
    units.add(expected.granularity === 'file' ? item.file : `${item.file}#${item.symbol ?? ''}`);
  }
  return units;
}

/**
 * File-level comparison of an answer with the oracle's key (the scorer of plan 03-07 does not exist
 * yet). `yes`: every key unit found and nothing extra; `partial`: some key units found; `no`:
 * none found, no parseable answer, or an abstention where the key has items. An abstain key is
 * `yes` only for an abstaining answer with no items.
 */
export function compareAnswer(expected: AnswerKey, answer: ParsedAnswer | null): Comparison {
  if (answer === null) return { correct: 'no', matched: 0, expected: keyUnits(expected).size, extra: 0 };
  if (expected.abstain) {
    const ok = answer.abstain && answer.items.length === 0;
    return { correct: ok ? 'yes' : 'no', matched: ok ? 1 : 0, expected: 1, extra: ok ? 0 : answer.items.length };
  }
  const want = keyUnits(expected);
  if (answer.abstain) return { correct: 'no', matched: 0, expected: want.size, extra: 0 };
  const got = answerUnits(expected, answer);
  let matched = 0;
  for (const unit of got) if (want.has(unit)) matched += 1;
  const extra = got.size - matched;
  const missing = want.size - matched;
  let correct: Comparison['correct'];
  if (matched === 0) correct = 'no';
  else if (missing === 0 && (extra === 0 || expected.equality === 'superset-ok')) correct = 'yes';
  else correct = 'partial';
  return { correct, matched, expected: want.size, extra };
}

export function markAnswer(expected: AnswerKey, answer: ParsedAnswer | null): 'yes' | 'partial' | 'no' {
  return compareAnswer(expected, answer).correct;
}

// ---------------------------------------------------------------------------------------------
// Tools

export interface McpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ToolContext {
  /** The throwaway checkout the session runs in. */
  corpusDir: string;
  /** A directory outside the repository for configs and raw streams. */
  scratchDir: string;
  /** The scratch install prefix of the third-party tools (never inside the repository, never global). */
  installDir: string;
}

export interface ScanTool {
  id: string;
  label: string;
  /** MCP servers of the strict config; the key is the server name the model sees. */
  mcpServers(ctx: ToolContext): Record<string, McpServerConfig>;
  /** `--allowedTools` entries naming the tool's own MCP tools. */
  allowedMcpTools: string[];
  /** Text placed before the question (for example a repo map); the model gets no other help. */
  extraPrompt?(ctx: ToolContext): string;
  /** Command whose first output line is the tool's version, when the tool can report one. */
  versionProbe?: { command: string; args: string[] };
  /** Built-in Claude Code tools added to the common set (the LSP tool, for the plugin row). */
  builtinTools?: string[];
  /** Plugin directories loaded with `--plugin-dir`; `prepare` writes them first. */
  pluginDirs?(ctx: ToolContext): string[];
  prepare?(ctx: ToolContext): void;
  /** Tool names the init event must list, otherwise the tool could not run. */
  requiredInitTools?: string[];
  notes: string;
}

const tsLanguageServer = (ctx: ToolContext): string =>
  path.join(ctx.installDir, 'npm', 'node_modules', '.bin', 'typescript-language-server');

/** Plugin directory for Claude Code's LSP tool: a local `.lsp.json`, loaded with `--plugin-dir` (never `/plugin install`). */
function lspPluginDir(ctx: ToolContext): string {
  return path.join(ctx.installDir, 'lsp-plugin');
}

export const SCAN_REGISTRY: Record<string, ScanTool> = {
  codegraph: {
    id: 'codegraph',
    label: 'colbymchenry/codegraph',
    mcpServers: () => ({ codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } }),
    allowedMcpTools: ['mcp__codegraph'],
    versionProbe: { command: 'codegraph', args: ['--version'] },
    notes: 'Local tree-sitter SQLite graph served over MCP; the index is built in the throwaway checkout first.',
  },
  'mcp-language-server': {
    id: 'mcp-language-server',
    label: 'mcp-language-server',
    mcpServers: (ctx) => ({
      'mcp-language-server': {
        type: 'stdio',
        command: path.join(ctx.installDir, 'bin', 'mcp-language-server'),
        args: ['--workspace', ctx.corpusDir, '--lsp', tsLanguageServer(ctx), '--', '--stdio'],
      },
    }),
    allowedMcpTools: ['mcp__mcp-language-server'],
    notes: 'Go MCP server wrapping one typescript-language-server for the workspace; installed in the scratch prefix.',
  },
  serena: {
    id: 'serena',
    label: 'Serena',
    mcpServers: (ctx) => ({
      serena: {
        type: 'stdio',
        command: path.join(ctx.installDir, 'bin', 'serena'),
        args: [
          'start-mcp-server',
          '--project',
          ctx.corpusDir,
          '--context',
          'claude-code',
          '--enable-web-dashboard',
          'false',
          '--open-web-dashboard',
          'false',
        ],
        env: { SERENA_HOME: path.join(ctx.installDir, 'serena-home') },
      },
    }),
    allowedMcpTools: ['mcp__serena'],
    notes: 'Python MCP server (serena-agent) with its own language-server backend; user data kept in a scratch SERENA_HOME.',
  },
  'aider-repo-map': {
    id: 'aider-repo-map',
    label: 'Aider repo-map',
    mcpServers: () => ({}),
    allowedMcpTools: [],
    extraPrompt: (ctx) => {
      const map = fs.readFileSync(path.join(ctx.installDir, 'aider-map.txt'), 'utf8').trimEnd();
      return [
        'The following repository map was produced by the Aider repo-map tool for this repository. It is the only help you are given besides the read-only tools.',
        '',
        '<repo-map>',
        map,
        '</repo-map>',
      ].join('\n');
    },
    notes: 'Not a query tool: the map text Aider prints with --show-repo-map is placed in the prompt of every session.',
  },
  'claude-code-lsp': {
    id: 'claude-code-lsp',
    label: 'Claude Code LSP plugin',
    mcpServers: () => ({}),
    allowedMcpTools: [],
    builtinTools: ['LSP'],
    requiredInitTools: ['LSP'],
    pluginDirs: (ctx) => [lspPluginDir(ctx)],
    prepare: (ctx) => {
      const dir = lspPluginDir(ctx);
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      const manifest = {
        name: 'scan-typescript-lsp',
        version: '0.0.0',
        description: 'Local plugin for the free-alternatives scan: typescript-language-server for TypeScript and JavaScript files.',
      };
      fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      const lsp = {
        typescript: {
          command: tsLanguageServer(ctx),
          args: ['--stdio'],
          extensionToLanguage: {
            '.ts': 'typescript',
            '.cts': 'typescript',
            '.mts': 'typescript',
            '.js': 'javascript',
            '.cjs': 'javascript',
            '.mjs': 'javascript',
          },
        },
      };
      fs.writeFileSync(path.join(dir, '.lsp.json'), `${JSON.stringify(lsp, null, 2)}\n`);
    },
    notes: 'Claude Code built-in LSP tool backed by typescript-language-server through a local plugin directory.',
  },
};

export function buildPrompt(text: string, extra?: string): string {
  const lines = [
    'You are answering a question about the source repository in your current working directory.',
    'Use only the tools you have been given. Do not modify anything.',
    '',
  ];
  if (extra !== undefined && extra.length > 0) lines.push(extra, '');
  lines.push(
    `Question: ${text}`,
    '',
    'Finish your final message with exactly one fenced json block of this shape and nothing after it:',
    '```json',
    '{"abstain": false, "items": [{"file": "repo-relative/path", "line": 12, "symbol": "name"}]}',
    '```',
    '"file" is required and must be a repository-relative path; "line" and "symbol" are optional. List each place once. If what the question asks about does not exist in this repository, set "abstain" to true and "items" to an empty list.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Running

export interface ScanOptions {
  corpusDir: string;
  scratchDir: string;
  /** Scratch install prefix of the third-party tools; required by every tool but codegraph. */
  installDir?: string;
  outPath?: string;
  questionsPath?: string;
  model?: string;
  toolVersion?: string;
  installMethod?: string;
  /** Run only these question ids. */
  only?: string[];
  maxBudgetUsd?: number;
  wallClockMs?: number;
  /** Test seams: replace the `claude` program and its version text. */
  executable?: string;
  prefixArgs?: string[];
  claudeCodeVersion?: string;
  now?: () => Date;
}

const defaultQuestionsPath = path.join(import.meta.dirname, 'scan-questions.json');

function probe(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd, shell: false });
  if (result.error !== undefined || result.status !== 0) return '';
  return result.stdout.split('\n')[0].trim();
}

/** Strip the home directory and the scratch directory out of text that goes into a committed file. */
export function scrub(text: string, scratchDir: string): string {
  let out = text;
  for (const dir of [scratchDir, (() => { try { return fs.realpathSync.native(scratchDir); } catch { return scratchDir; } })()]) {
    if (dir.length > 1) out = out.split(dir).join('<scratch>');
  }
  const home = os.homedir();
  if (home.length > 1) out = out.split(home).join('~');
  return out.replace(/\/private\/tmp\b/g, '<tmp>');
}

function rowOf(
  question: ScanQuestion,
  outcome: SessionOutcome,
  comparison: Comparison,
  parsed: ParsedAnswer | null,
): ScanRow {
  const usage = outcome.result?.usage ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  return {
    questionId: question.id,
    category: question.category,
    status: outcome.status,
    correct: comparison.correct,
    tokens: { ...usage, billable: billableTokens(usage) },
    toolCalls: outcome.toolCallTotal,
    toolCallsByName: outcome.toolCalls,
    initTools: outcome.init?.tools ?? [],
    mcpServers: outcome.init?.mcpServers ?? [],
    wallMs: outcome.wallMs,
    costUsd: outcome.result?.totalCostUsd ?? 0,
    numTurns: outcome.result?.numTurns ?? 0,
    answer: {
      parsed: parsed !== null,
      abstain: parsed?.abstain ?? false,
      itemCount: parsed?.items.length ?? 0,
      matched: comparison.matched,
      expected: comparison.expected,
      extra: comparison.extra,
    },
    gapNote: '',
  };
}

function totalsOf(rows: readonly ScanRow[]): ScanRunFile['totals'] {
  const tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, billable: 0 };
  let toolCalls = 0;
  let wallMs = 0;
  let costUsd = 0;
  for (const row of rows) {
    tokens.input += row.tokens.input;
    tokens.output += row.tokens.output;
    tokens.cacheCreation += row.tokens.cacheCreation;
    tokens.cacheRead += row.tokens.cacheRead;
    tokens.billable += row.tokens.billable;
    toolCalls += row.toolCalls;
    wallMs += row.wallMs;
    costUsd += row.costUsd;
  }
  return {
    sessions: rows.length,
    yes: rows.filter((r) => r.correct === 'yes').length,
    partial: rows.filter((r) => r.correct === 'partial').length,
    no: rows.filter((r) => r.correct === 'no').length,
    tokens,
    toolCalls,
    wallMs,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
  };
}

/** Why a session whose server never connected means the tool could not run, or null when it did. */
function serverFailure(init: InitEvent | null, tool: ScanTool): string | null {
  if (init === null) return 'the session produced no init event';
  for (const name of Object.keys(tool.mcpServers({ corpusDir: '', scratchDir: '', installDir: '' }))) {
    const server = init.mcpServers.find((s) => s.name === name);
    if (server === undefined) return `mcp server ${name} absent from the init event`;
    if (server.status !== 'connected') return `mcp server ${name} status ${server.status}`;
  }
  for (const required of tool.requiredInitTools ?? []) {
    if (!init.tools.includes(required)) return `tool ${required} absent from the init event`;
  }
  return null;
}

export async function runScan(tool: ScanTool, options: ScanOptions): Promise<ScanRunFile> {
  if (tool.id !== 'codegraph' && (options.installDir ?? '') === '' && tool.id in SCAN_REGISTRY) {
    throw new Error(`tool ${tool.id} needs --install-dir (the scratch install prefix)`);
  }
  const questionFile = loadScanQuestions(options.questionsPath ?? defaultQuestionsPath);
  const only = options.only === undefined ? null : new Set(options.only);
  const questions = questionFile.questions.filter((q) => only === null || only.has(q.id));
  const corpusSha = probe('git', ['rev-parse', 'HEAD'], options.corpusDir);
  if (corpusSha !== questionFile.corpusSha) {
    throw new Error(`the checkout is at ${corpusSha || 'an unknown commit'}, the scan questions pin ${questionFile.corpusSha}`);
  }
  fs.mkdirSync(options.scratchDir, { recursive: true });
  const ctx: ToolContext = { corpusDir: options.corpusDir, scratchDir: options.scratchDir, installDir: options.installDir ?? '' };
  tool.prepare?.(ctx);
  const sessionTools = [...SCAN_TOOLS, ...(tool.builtinTools ?? [])];
  const mcpConfigPath = path.join(options.scratchDir, `${tool.id}.mcp.json`);
  fs.writeFileSync(mcpConfigPath, `${JSON.stringify({ mcpServers: tool.mcpServers(ctx) }, null, 2)}\n`);
  const extra = tool.extraPrompt?.(ctx);
  const allowedTools = [...SCAN_READ_ONLY_ALLOWED, ...(tool.builtinTools ?? []), ...tool.allowedMcpTools];
  const maxBudgetUsd = options.maxBudgetUsd ?? SCAN_MAX_BUDGET_USD_PER_SESSION;
  const wallClockMs = options.wallClockMs ?? SCAN_SESSION_WALL_CLOCK_MS;
  const model = options.model ?? SCAN_MODEL;
  const claudeCodeVersion =
    options.claudeCodeVersion ?? probe('claude', ['--version']).replace(/\s*\(Claude Code\)\s*$/, '');
  const toolVersion = options.toolVersion ?? (tool.versionProbe ? probe(tool.versionProbe.command, tool.versionProbe.args) : '');

  const rows: ScanRow[] = [];
  let modelId = '';
  let couldNotRun: string | null = null;
  for (const question of questions) {
    const spec: SessionSpec = {
      prompt: buildPrompt(question.text, extra),
      cwd: options.corpusDir,
      tools: sessionTools,
      allowedTools,
      mcpConfigPath,
      pluginDirs: tool.pluginDirs?.(ctx) ?? [],
      model,
      maxBudgetUsd,
      wallClockMs,
      rawStreamPath: path.join(options.scratchDir, `${tool.id}-${question.id}.stream.jsonl`),
    };
    if (options.executable !== undefined) spec.executable = options.executable;
    if (options.prefixArgs !== undefined) spec.prefixArgs = options.prefixArgs;
    const outcome = await runClaudeSession(spec);
    if (rows.length === 0) {
      const failure = serverFailure(outcome.init, tool);
      if (failure !== null) {
        couldNotRun = scrub(failure, options.scratchDir);
        break;
      }
    }
    if (outcome.init !== null && modelId === '') modelId = outcome.init.model;
    const parsed = outcome.result === null ? null : parseAnswer(outcome.result.text, options.corpusDir);
    rows.push(rowOf(question, outcome, compareAnswer(question.expected, parsed), parsed));
    // A session that hit a cap is recorded as it is and never retried.
  }

  const run: ScanRunFile = {
    schemaVersion: 1,
    tool: {
      id: tool.id,
      label: tool.label,
      version: toolVersion.length > 0 ? toolVersion : 'unknown',
      installMethod: options.installMethod ?? 'not recorded',
    },
    claudeCodeVersion,
    model: modelId.length > 0 ? modelId : model,
    date: (options.now?.() ?? new Date()).toISOString().slice(0, 10),
    corpus: { id: questionFile.corpusId, sha: corpusSha },
    limits: { maxBudgetUsdPerSession: maxBudgetUsd, sessionWallClockMs: wallClockMs },
    isolation: { settingSources: '', strictMcpConfig: true, tools: sessionTools, allowedTools },
    couldNotRun: couldNotRun === null ? null : { reason: couldNotRun },
    rows: couldNotRun === null ? rows : [],
    totals: totalsOf(couldNotRun === null ? rows : []),
  };
  ScanRunFileSchema.parse(run);
  const serialized = `${JSON.stringify(run, null, 2)}\n`;
  if (serialized.includes(os.homedir()) && os.homedir().length > 1) {
    throw new Error('refusing to write a run file that contains the home directory');
  }
  if (options.outPath !== undefined) {
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, serialized);
  }
  return run;
}

// ---------------------------------------------------------------------------------------------
// Embedding the oracle's keys

/** Recompute `expected` for every question from the oracle and rewrite the question file. */
export async function embedKeys(options: { repo: string; tsconfig: string; questionsPath: string }): Promise<void> {
  const { computeAnswerKey, ORACLE_VERSION } = await import('./oracle.ts');
  const raw = JSON.parse(fs.readFileSync(options.questionsPath, 'utf8')) as {
    corpusId: string;
    corpusSha: string;
    oracleVersion?: string;
    questions: (Omit<ScanQuestion, 'expected'> & { expected?: unknown })[];
  };
  const sha = probe('git', ['rev-parse', 'HEAD'], options.repo);
  if (sha !== raw.corpusSha) throw new Error(`the checkout is at ${sha}, the question file pins ${raw.corpusSha}`);
  const questions: ScanQuestion[] = [];
  for (const entry of raw.questions) {
    const question = QuestionSchema.parse({
      id: `q-${Number(entry.id.slice(2))}`,
      category: entry.category,
      text: entry.text,
      key: entry.key,
    });
    const key = await computeAnswerKey(question, { repoDir: options.repo, tsconfig: options.tsconfig });
    questions.push(ScanQuestionSchema.parse({ id: entry.id, category: entry.category, text: entry.text, key: entry.key, expected: { ...key, questionId: entry.id } }));
  }
  const file: ScanQuestionFile = ScanQuestionFileSchema.parse({
    corpusId: raw.corpusId,
    corpusSha: raw.corpusSha,
    oracleVersion: ORACLE_VERSION,
    questions,
  });
  fs.writeFileSync(options.questionsPath, `${JSON.stringify(file, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Gap notes

/**
 * Sets the `gapNote` of rows in a run file from `{ "s-006": "text" }`. The notes are written by the
 * person reading the transcripts, so they are applied after the run; a note is kept free of
 * repository text, and any home or scratch path is scrubbed out of it.
 */
export function applyGapNotes(runPath: string, notes: Readonly<Record<string, string>>, scratchDir: string): void {
  const run = loadScanRun(runPath);
  for (const id of Object.keys(notes)) {
    if (!run.rows.some((row) => row.questionId === id)) throw new Error(`no row ${id} in ${path.basename(runPath)}`);
  }
  const rows = run.rows.map((row) =>
    notes[row.questionId] === undefined ? row : { ...row, gapNote: scrub(notes[row.questionId], scratchDir) },
  );
  const next: ScanRunFile = ScanRunFileSchema.parse({ ...run, rows });
  fs.writeFileSync(runPath, `${JSON.stringify(next, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Command line

const USAGE = `usage:
  node scripts/eval/scan.ts --tool <id> --corpus-dir <dir> --out <file> [--scratch-dir <dir>] [--install-dir <dir>] [--model <alias>]
                            [--tool-version <text>] [--install-method <text>] [--only s-001,s-002]
  node scripts/eval/scan.ts embed-keys --repo <dir> [--tsconfig tsconfig.json] [--questions <file>]
  node scripts/eval/scan.ts gap-notes --run <file> --notes <json file>
tools: ${Object.keys(SCAN_REGISTRY).join(', ')}
`;

export async function main(argv: readonly string[]): Promise<number> {
  const embed = argv[0] === 'embed-keys';
  const gaps = argv[0] === 'gap-notes';
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args: [...(embed || gaps ? argv.slice(1) : argv)],
      options: {
        run: { type: 'string' },
        notes: { type: 'string' },
        tool: { type: 'string' },
        'corpus-dir': { type: 'string' },
        out: { type: 'string' },
        'scratch-dir': { type: 'string' },
        'install-dir': { type: 'string' },
        model: { type: 'string' },
        'tool-version': { type: 'string' },
        'install-method': { type: 'string' },
        only: { type: 'string' },
        repo: { type: 'string' },
        tsconfig: { type: 'string' },
        questions: { type: 'string' },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  try {
    if (gaps) {
      if (values['run'] === undefined || values['notes'] === undefined) {
        process.stderr.write(USAGE);
        return 2;
      }
      const notes = z.record(z.string(), z.string()).parse(JSON.parse(fs.readFileSync(values['notes'], 'utf8')));
      applyGapNotes(path.resolve(values['run']), notes, path.dirname(path.resolve(values['notes'])));
      return 0;
    }
    if (embed) {
      if (values['repo'] === undefined) {
        process.stderr.write(USAGE);
        return 2;
      }
      await embedKeys({
        repo: values['repo'],
        tsconfig: values['tsconfig'] ?? 'tsconfig.json',
        questionsPath: values['questions'] ?? defaultQuestionsPath,
      });
      return 0;
    }
    const tool = values['tool'] === undefined ? undefined : SCAN_REGISTRY[values['tool']];
    if (tool === undefined || values['corpus-dir'] === undefined || values['out'] === undefined) {
      process.stderr.write(USAGE);
      return 2;
    }
    const scratchDir = values['scratch-dir'] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-atlas-scan-'));
    const options: ScanOptions = {
      corpusDir: path.resolve(values['corpus-dir']),
      scratchDir: path.resolve(scratchDir),
      outPath: path.resolve(values['out']),
    };
    if (values['install-dir'] !== undefined) options.installDir = path.resolve(values['install-dir']);
    if (values['model'] !== undefined) options.model = values['model'];
    if (values['tool-version'] !== undefined) options.toolVersion = values['tool-version'];
    if (values['install-method'] !== undefined) options.installMethod = values['install-method'];
    if (values['only'] !== undefined) options.only = values['only'].split(',').map((s) => s.trim());
    const run = await runScan(tool, options);
    process.stdout.write(
      `${tool.id}: ${run.couldNotRun !== null ? `could not run: ${run.couldNotRun.reason}` : `${run.totals.yes} yes, ${run.totals.partial} partial, ${run.totals.no} no, ${run.totals.tokens.billable} billable tokens, $${run.totals.costUsd}`}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
