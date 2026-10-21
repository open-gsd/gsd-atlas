/**
 * Runs exploratory probe sessions with headless Claude Code, one job at a time, and keeps a compact record
 * per session. UNSCORED: no verdict is computed, nothing is registered, and the answer-vs-key comparison is
 * descriptive only. Built over the registered harness helpers (read-only use): `buildClaudeArgs`,
 * `runClaudeSession`, `buildMcpConfig`, `buildPluginDir`, `cloneCheckout`, `buildPrompt`.
 *
 *   node scripts/probes/driver.ts --jobs <jobs.json> --out <dir> --corpus <dir> --scratch <dir> --ledger <file>
 *
 * Auth: the run uses the signed-in claude.ai subscription of this machine only. Every ANTHROPIC* and
 * CLAUDE* environment variable is removed from the child environment; none is ever set or printed.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { buildMcpConfig, buildPluginDir } from '../eval/arms.ts';
import { runClaudeSession } from '../eval/claude-session.ts';
import { buildPrompt } from '../eval/harness.ts';
import { cloneCheckout } from '../eval/prepare-corpus.ts';
import { planFor, scrubbedEnv } from './configs.ts';
import type { ConfigId } from './configs.ts';
import { shouldStop } from './limits.ts';
import { makePatchedCopy } from './patch-server.ts';
import type { ProbeQuestion } from './questions.ts';
import { compareToKey, rateLimitOf, recordOf, resultBytesByTool } from './stream.ts';
import type { FirstRequest, RateLimit, Usage } from './stream.ts';

export const ONE_TURN_PROMPT = 'Reply with the single word ok.';

export interface Job {
  jobId: string;
  probe: string;
  config: ConfigId;
  questionId?: string;
  run: number;
  maxBudgetUsd: number;
  /** Skip building the index (one-turn sessions never call a tool). */
  skipIndex?: boolean;
  /** Wall clock in milliseconds; default 600000. */
  wallClockMs?: number;
}

export interface JobDeps {
  corpusDir: string;
  scratchDir: string;
  outDir: string;
  atlasBin: string;
  skillPath: string;
  hookScript: string;
  answerSchema: string;
  model: string;
  questions: ReadonlyMap<string, ProbeQuestion>;
  /** Distinct key files per question. */
  keyFiles: ReadonlyMap<string, readonly string[]>;
  executable: string;
  /** Arguments placed before the claude flags (for example `nice -n 10 claude`, or a fake script). */
  executablePrefix: readonly string[];
  /** Extra variables for the child only. */
  env?: Record<string, string>;
  nice: boolean;
}

export interface Record_ {
  jobId: string;
  probe: string;
  config: ConfigId;
  questionId: string | null;
  kind: string | null;
  run: number;
  status: string;
  claudeCodeVersion: string | null;
  apiKeySource: string | null;
  initToolCount: number | null;
  initMcpToolCount: number | null;
  initTools: string[];
  initSkills: string[];
  firstRequest: FirstRequest | null;
  usage: Usage;
  numTurns: number;
  toolCalls: number;
  toolCallsExStructured: number;
  atlasCalls: number;
  byTool: Record<string, number>;
  skillLoaded: boolean;
  costUsd: number | null;
  wallMs: number;
  answer: { files: number; equal: boolean; matched: number; missing: number; extra: number } | null;
  atlasResultBytes: { tool: string; bytes: number }[];
  denied: number;
  rate: RateLimit;
}

const patchedCache = new Map<string, string>();

function patchedBin(scratchDir: string, patch: object): string {
  const key = createHash('sha256').update(JSON.stringify(patch)).digest('hex').slice(0, 12);
  const cached = patchedCache.get(key);
  if (cached !== undefined) return cached;
  const dir = path.join(scratchDir, 'patched', key);
  fs.rmSync(dir, { recursive: true, force: true });
  makePatchedCopy(dir, patch);
  const bin = path.join(dir, 'dist', 'bin', 'gsd-atlas.js');
  patchedCache.set(key, bin);
  return bin;
}

function prep(args: string[], cwd: string, env: Record<string, string>): boolean {
  const done = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore', timeout: 20 * 60_000 });
  return done.error === undefined && done.status === 0;
}

export async function runJob(job: Job, deps: JobDeps): Promise<{ record: Record_; rawStream: string }> {
  const sessionDir = path.join(deps.scratchDir, 'sessions', job.jobId);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  const repoDir = path.join(sessionDir, 'repo');
  const storeDir = path.join(sessionDir, 'store');
  const userDir = path.join(sessionDir, 'user');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  cloneCheckout(deps.corpusDir, repoDir);
  const streamsDir = path.join(deps.outDir, 'streams');
  fs.mkdirSync(streamsDir, { recursive: true });
  const rawStream = path.join(streamsDir, `${job.jobId}.jsonl`);
  try {
    const mcpConfigPath = path.join(sessionDir, 'mcp.json');
    const plan = planFor(job.config, {
      mcpConfigPath,
      pluginDir: path.join(sessionDir, 'plugin'),
      hookScript: deps.hookScript,
      answerSchema: deps.answerSchema,
      model: deps.model,
      maxBudgetUsd: job.maxBudgetUsd,
      wallClockMs: job.wallClockMs ?? 600_000,
    });
    const atlasBin = plan.serverPatch === undefined ? deps.atlasBin : patchedBin(deps.scratchDir, plan.serverPatch);
    const childEnv = { GSD_ATLAS_STORE_DIR: storeDir, GSD_ATLAS_USER_DIR: userDir };
    if (plan.atlas && job.skipIndex !== true) {
      // Prepared the way the atlas arm is: build, then `maintain resolve` (its status does not stop the cell).
      if (!prep([deps.atlasBin, 'build', '--repo', repoDir], repoDir, childEnv)) throw new Error(`index build failed for ${job.jobId}`);
      prep([deps.atlasBin, 'maintain', 'resolve', '--repo', repoDir], repoDir, childEnv);
    }
    buildMcpConfig(plan.atlas ? 'atlas' : 'grep', { atlasBin, storeDir, userDir, configPath: mcpConfigPath });
    if (plan.spec.pluginDirs.length > 0) buildPluginDir(sessionDir, deps.skillPath);
    const question = job.questionId === undefined ? undefined : deps.questions.get(job.questionId);
    if (job.questionId !== undefined && question === undefined) throw new Error(`unknown question ${job.questionId}`);
    const prompt = question === undefined ? ONE_TURN_PROMPT : buildPrompt({ text: question.text } as never, 'grep');
    const outcome = await runClaudeSession({
      ...plan.spec,
      prompt,
      cwd: repoDir,
      env: { ...childEnv, ...(deps.env ?? {}), ...(plan.spec.env ?? {}) },
      executable: deps.executable,
      prefixArgs: [...deps.executablePrefix, ...plan.prefixArgs],
      rawStreamPath: rawStream,
    });
    const text = fs.existsSync(rawStream) ? fs.readFileSync(rawStream, 'utf8') : '';
    const facts = recordOf(text, { wallMs: outcome.wallMs, repoRoots: [repoDir, fs.realpathSync.native(repoDir)] });
    const key = question === undefined ? undefined : deps.keyFiles.get(question.id);
    const cmp = key === undefined || facts.answerFiles === null ? null : compareToKey(facts.answerFiles, key);
    const denied = text.split('\n').filter((l) => l.includes('Searching code with grep, rg, find or cat is disabled')).length;
    const record: Record_ = {
      jobId: job.jobId,
      probe: job.probe,
      config: job.config,
      questionId: question?.id ?? null,
      kind: question?.key.kind ?? null,
      run: job.run,
      status: facts.status === 'ok' && outcome.status === 'ok' ? 'ok' : `${facts.status}/${outcome.status}`,
      claudeCodeVersion: facts.claudeCodeVersion,
      apiKeySource: facts.apiKeySource,
      initToolCount: facts.init?.toolCount ?? null,
      initMcpToolCount: facts.init?.mcpToolCount ?? null,
      initTools: facts.init?.tools ?? [],
      initSkills: facts.init?.skills ?? [],
      firstRequest: facts.firstRequest,
      usage: facts.usage,
      numTurns: facts.numTurns,
      toolCalls: facts.toolCalls,
      toolCallsExStructured: facts.toolCallsExStructured,
      atlasCalls: facts.atlasCalls,
      byTool: facts.byTool,
      skillLoaded: facts.skillLoaded,
      costUsd: facts.costUsd,
      wallMs: facts.wallMs,
      answer: cmp === null || facts.answerFiles === null ? null : { files: facts.answerFiles.length, ...cmp },
      atlasResultBytes: resultBytesByTool(text).filter((r) => r.tool.startsWith('mcp__gsd-atlas__')),
      denied,
      rate: rateLimitOf(text),
    };
    return { record, rawStream };
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function readLines(file: string): Record_[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record_);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      jobs: { type: 'string' },
      out: { type: 'string' },
      corpus: { type: 'string' },
      scratch: { type: 'string' },
      ledger: { type: 'string' },
      questions: { type: 'string' },
      answers: { type: 'string' },
      repo: { type: 'string' },
      model: { type: 'string', default: 'claude-sonnet-5-5' },
      'no-nice': { type: 'boolean', default: false },
    },
  });
  for (const k of ['jobs', 'out', 'corpus', 'scratch', 'ledger', 'questions', 'answers', 'repo'] as const) {
    if (values[k] === undefined) throw new Error(`--${k} is required`);
  }
  // Auth hygiene: no ANTHROPIC* or CLAUDE* variable reaches a child; the subscription login is used.
  for (const name of Object.keys(process.env)) if (!(name in scrubbedEnv({ [name]: process.env[name] }))) delete process.env[name];
  const repo = values.repo as string;
  const questions = new Map(
    (JSON.parse(fs.readFileSync(values.questions as string, 'utf8')) as { questions: ProbeQuestion[] }).questions.map((q) => [q.id, q] as const),
  );
  const keyFiles = new Map<string, string[]>();
  for (const a of (JSON.parse(fs.readFileSync(values.answers as string, 'utf8')) as { answers: { questionId: string; items: { file: string }[] }[] }).answers) {
    keyFiles.set(a.questionId, [...new Set(a.items.map((i) => i.file))].sort());
  }
  const jobs = JSON.parse(fs.readFileSync(values.jobs as string, 'utf8')) as Job[];
  const out = values.out as string;
  const recordsFile = path.join(out, 'records.jsonl');
  fs.mkdirSync(out, { recursive: true });
  const nice = values['no-nice'] !== true;
  const deps: JobDeps = {
    corpusDir: values.corpus as string,
    scratchDir: values.scratch as string,
    outDir: out,
    atlasBin: path.join(repo, 'dist', 'bin', 'gsd-atlas.js'),
    skillPath: path.join(repo, 'skills', 'gsd-atlas', 'SKILL.md'),
    hookScript: path.join(repo, 'scripts', 'probes', 'route-hook.ts'),
    answerSchema: JSON.stringify(JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'eval', 'answer-schema.json'), 'utf8')) as unknown),
    model: values.model as string,
    questions,
    keyFiles,
    executable: nice ? 'nice' : 'claude',
    executablePrefix: nice ? ['-n', '10', 'claude'] : [],
    nice,
  };
  const done = new Set(readLines(recordsFile).map((r) => r.jobId));
  const ledger = values.ledger as string;
  let rate: RateLimit = { fiveHour: null, sevenDay: null, isUsingOverage: null, overageStatus: null };
  const prior = readLines(ledger);
  if (prior.length > 0) rate = prior.at(-1)?.rate ?? rate;
  for (const job of jobs) {
    if (done.has(job.jobId)) continue;
    const spent = readLines(ledger).reduce((a, r) => a + (r.costUsd ?? 0), 0);
    const reason = shouldStop({ spentUsd: spent, nextMaxUsd: job.maxBudgetUsd, rate });
    if (reason !== null) {
      process.stdout.write(`STOP before ${job.jobId}: ${reason}\n`);
      process.exitCode = 3;
      return;
    }
    const { record } = await runJob(job, deps);
    fs.appendFileSync(recordsFile, `${JSON.stringify(record)}\n`);
    fs.appendFileSync(ledger, `${JSON.stringify(record)}\n`);
    if (record.rate.fiveHour !== null || record.rate.sevenDay !== null || record.rate.isUsingOverage !== null) rate = record.rate;
    process.stdout.write(
      `${record.jobId} ${record.status} first=${String(record.firstRequest?.total)} bill=${String(record.usage.billable)} atlas=${String(record.atlasCalls)} tools=${String(record.toolCalls)} cost=${String(record.costUsd)} 5h=${String(record.rate.fiveHour)} 7d=${String(record.rate.sevenDay)} overage=${String(record.rate.isUsingOverage)} key=${record.answer === null ? 'n/a' : String(record.answer.equal)}\n`,
    );
    if (record.apiKeySource !== null && record.apiKeySource !== 'none') {
      process.stdout.write(`STOP: unexpected apiKeySource ${record.apiKeySource}\n`);
      process.exitCode = 4;
      return;
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
