/**
 * Driver of the UNSCORED, UNREGISTERED angular pilot (plan sections 4 to 6). It extends the probe driver
 * (`scripts/probes/driver.ts`, read-only use) with the three-condition schedule, the angular key files, the
 * closed-book control, the calibration batch and a per-chunk check. Nothing is launched without `--launch`.
 *
 *   node scripts/angular-pilot/driver.ts --dry-run [--cap-usd N] [--concurrency 1|2]
 *   node scripts/angular-pilot/driver.ts --launch --stage closed-book|calibration|pilot --corpus <prepared dir>
 *        --out <dir> --scratch <dir> --ledger <file> --repo <atlas repo root> [--cap-usd N] [--concurrency 1|2]
 *
 * Auth: the signed-in claude.ai subscription only (four-field `claude auth status` filter before each chunk). Every
 * ANTHROPIC* and CLAUDE* variable is removed from the child environment; none is set or printed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runClaudeSession } from '../eval/claude-session.ts';
import { buildPrompt } from '../eval/harness.ts';
import { scrubbedEnv } from '../probes/configs.ts';
import { runJob, type Job, type JobDeps } from '../probes/driver.ts';
import type { ProbeQuestion } from '../probes/questions.ts';
import { rateLimitOf, recordOf } from '../probes/stream.ts';
import {
  CLAUDE_VERSION,
  CLOSED_BOOK_BUDGET_USD,
  CLOSED_BOOK_MCP_CONFIG,
  MODEL,
  SESSION_BUDGET_USD,
  WALL_CLOCK_MS,
  answerFromStream,
  authOk,
  buildSchedule,
  calibrationBatch,
  calibrationSummary,
  chunkCheck,
  chunkSchedule,
  closedBookJobs,
  closedBookSpec,
  compareAnswer,
  parseCap,
  renderDryRun,
  resolveConcurrency,
  type KeyEntry,
  type PilotJob,
  type PilotRecord,
} from './pilot-plan.ts';

const DOCS = path.resolve(import.meta.dirname, '..', '..', 'docs', 'eval', 'angular-pilot');

export interface RunChunksOptions {
  chunks: readonly (readonly PilotJob[])[];
  done: ReadonlySet<string>;
  runOne: (job: PilotJob) => Promise<PilotRecord>;
  authOk: () => boolean;
  capUsd: number;
  spentBefore: number;
  expectedVersion: string;
  concurrency: 1 | 2;
  onRecord?: (record: PilotRecord) => void;
}

export interface RunChunksResult {
  records: PilotRecord[];
  stoppedAt: number | null;
  reasons: string[];
  spentUsd: number;
}

/**
 * Runs the chunks in order. Before every session: the notional cap (spent + the cap of every session in flight + this
 * one); after every session: a quick check of its record; after every chunk: the full check. Stops at the first
 * reason and reports the chunk index. Sessions already in `done` are skipped (resume).
 */
export async function runChunks(opts: RunChunksOptions): Promise<RunChunksResult> {
  const records: PilotRecord[] = [];
  let spent = opts.spentBefore;
  for (let ci = 0; ci < opts.chunks.length; ci += 1) {
    if (!opts.authOk()) return { records, stoppedAt: ci, reasons: ['auth: the subscription login filter did not pass'], spentUsd: spent - opts.spentBefore };
    const pending = opts.chunks[ci]!.filter((j) => !opts.done.has(j.jobId));
    const conc = resolveConcurrency(opts.concurrency, pending);
    const chunkRecords: PilotRecord[] = [];
    const halted: string[] = [];
    const spentAtStart = spent;
    let next = 0;
    let inflight = 0;
    const worker = async (): Promise<void> => {
      while (halted.length === 0) {
        const job = pending[next];
        if (job === undefined) return;
        next += 1;
        if (spent + (inflight + 1) * SESSION_BUDGET_USD > opts.capUsd) {
          halted.push(`notional ${spent.toFixed(2)} USD + next session cap ${SESSION_BUDGET_USD.toFixed(2)} would pass the cap ${opts.capUsd.toFixed(2)}`);
          return;
        }
        inflight += 1;
        const rec = await opts.runOne(job);
        inflight -= 1;
        spent += rec.costUsd ?? 0;
        chunkRecords.push(rec);
        records.push(rec);
        opts.onRecord?.(rec);
        const quick = chunkCheck([rec], { capUsd: Number.POSITIVE_INFINITY, spentBefore: 0, nextMaxUsd: 0, expectedVersion: opts.expectedVersion });
        halted.push(...quick.reasons.filter((r) => !r.startsWith('no rate-limit reading')));
      }
    };
    await Promise.all(Array.from({ length: conc }, () => worker()));
    if (halted.length > 0) return { records, stoppedAt: ci, reasons: halted, spentUsd: spent - opts.spentBefore };
    if (chunkRecords.length > 0) {
      const full = chunkCheck(chunkRecords, { capUsd: opts.capUsd, spentBefore: spentAtStart, nextMaxUsd: 0, expectedVersion: opts.expectedVersion });
      if (full.stop) {
        return { records, stoppedAt: ci, reasons: full.reasons, spentUsd: spent - opts.spentBefore };
      }
    }
  }
  return { records, stoppedAt: null, reasons: [], spentUsd: spent - opts.spentBefore };
}

// ---------------------------------------------------------------------------------------------
// Real runs (only with --launch)

interface QuestionFile {
  questions: { id: string; category: string; text: string; key: Record<string, unknown> }[];
}
interface AnswerFile {
  answers: { questionId: string; abstain: boolean; granularity: KeyEntry['granularity']; items: KeyEntry['items'] }[];
}

function readLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

function claudeAuthOk(): boolean {
  const r = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return false;
  try {
    return authOk(JSON.parse(r.stdout) as unknown);
  } catch {
    return false;
  }
}

function toPilotRecord(job: { jobId: string; condition: PilotRecord['condition'] }, r: { status: string; claudeCodeVersion: string | null; apiKeySource: string | null; initMcpToolCount: number | null; atlasCalls: number; usage: { billable: number }; costUsd: number | null; rate: PilotRecord['rate'] }): PilotRecord {
  return { jobId: job.jobId, condition: job.condition, status: r.status, claudeCodeVersion: r.claudeCodeVersion, apiKeySource: r.apiKeySource, initMcpToolCount: r.initMcpToolCount, atlasCalls: r.atlasCalls, usage: { billable: r.usage.billable }, costUsd: r.costUsd, rate: r.rate };
}

async function launch(values: Record<string, string | boolean | undefined>): Promise<void> {
  const need = (k: string): string => {
    const v = values[k];
    if (typeof v !== 'string') throw new Error(`--${k} is required`);
    return v;
  };
  const stage = need('stage');
  if (stage !== 'closed-book' && stage !== 'calibration' && stage !== 'pilot') throw new Error('--stage must be closed-book, calibration or pilot');
  const capUsd = parseCap(typeof values['cap-usd'] === 'string' ? values['cap-usd'] : undefined);
  const out = need('out');
  const scratch = need('scratch');
  const ledger = need('ledger');
  const repo = need('repo');
  for (const name of Object.keys(process.env)) if (!(name in scrubbedEnv({ [name]: process.env[name] }))) delete process.env[name];
  const qf = JSON.parse(fs.readFileSync(typeof values['questions'] === 'string' ? values['questions'] : path.join(DOCS, 'pilot-questions.json'), 'utf8')) as QuestionFile;
  const af = JSON.parse(fs.readFileSync(typeof values['answers'] === 'string' ? values['answers'] : path.join(DOCS, 'pilot-answers.json'), 'utf8')) as AnswerFile;
  const keys = new Map(af.answers.map((a) => [a.questionId, a] as const));
  const questions = new Map(qf.questions.map((q) => [q.id, q as unknown as ProbeQuestion] as const));
  const keyFiles = new Map(af.answers.map((a) => [a.questionId, [...new Set(a.items.map((i) => i.file ?? ''))].sort()] as const));
  const ids = qf.questions.map((q) => q.id);
  fs.mkdirSync(out, { recursive: true });
  const recordsFile = path.join(out, `${stage}-records.jsonl`);
  const answerSchema = JSON.stringify(JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'eval', 'answer-schema.json'), 'utf8')) as unknown);
  const compare = (questionId: string, text: string, roots: string[]): Record<string, unknown> | null => {
    const ans = answerFromStream(text, roots);
    const key = keys.get(questionId);
    return ans === null || key === undefined ? null : { ...compareAnswer(ans, { abstain: key.abstain, granularity: key.granularity, items: key.items }) };
  };
  const doneIds = new Set(readLines<{ jobId: string }>(recordsFile).map((r) => r.jobId));
  const spentBefore = readLines<{ costUsd: number | null }>(ledger).reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const concurrency = Number(values['concurrency'] ?? 1);

  let runOne: (job: PilotJob) => Promise<PilotRecord>;
  let chunks: PilotJob[][];
  if (stage === 'closed-book') {
    chunks = [closedBookJobs(ids).map((j, i) => ({ jobId: j.jobId, condition: 'G' as const, config: 'grep' as const, questionId: j.questionId, run: j.run, group: i }))];
    runOne = async (job) => {
      const dir = path.join(scratch, 'closed-book', job.jobId);
      fs.rmSync(dir, { recursive: true, force: true });
      const cwd = path.join(dir, 'empty');
      fs.mkdirSync(cwd, { recursive: true });
      const mcp = path.join(dir, 'mcp.json');
      fs.writeFileSync(mcp, CLOSED_BOOK_MCP_CONFIG);
      const rawStream = path.join(out, 'streams', `${job.jobId}.jsonl`);
      fs.mkdirSync(path.dirname(rawStream), { recursive: true });
      const spec = closedBookSpec({ mcpConfigPath: mcp, answerSchema, model: MODEL, maxBudgetUsd: CLOSED_BOOK_BUDGET_USD, wallClockMs: WALL_CLOCK_MS });
      const outcome = await runClaudeSession({ ...spec, prompt: buildPrompt({ text: questions.get(job.questionId)!.text } as never, 'grep'), cwd, env: {}, executable: 'nice', prefixArgs: ['-n', '10', 'claude'], rawStreamPath: rawStream });
      const text = fs.existsSync(rawStream) ? fs.readFileSync(rawStream, 'utf8') : '';
      const facts = recordOf(text, { wallMs: outcome.wallMs });
      const rate = rateLimitOf(text);
      const rec = { ...toPilotRecord({ jobId: job.jobId, condition: 'CB' }, { status: facts.status === 'ok' && outcome.status === 'ok' ? 'ok' : `${facts.status}/${outcome.status}`, claudeCodeVersion: facts.claudeCodeVersion, apiKeySource: facts.apiKeySource, initMcpToolCount: facts.init?.mcpToolCount ?? null, atlasCalls: facts.atlasCalls, usage: facts.usage, costUsd: facts.costUsd, rate }), questionId: job.questionId, toolCalls: facts.toolCalls, pilot: compare(job.questionId, text, []) };
      fs.rmSync(dir, { recursive: true, force: true });
      return rec;
    };
  } else {
    const corpus = need('corpus');
    const deps: JobDeps = {
      corpusDir: corpus,
      scratchDir: scratch,
      outDir: out,
      atlasBin: path.join(repo, 'dist', 'bin', 'gsd-atlas.js'),
      skillPath: path.join(repo, 'skills', 'gsd-atlas', 'SKILL.md'),
      hookScript: path.join(repo, 'scripts', 'probes', 'route-hook.ts'),
      answerSchema,
      model: MODEL,
      questions,
      keyFiles,
      executable: 'nice',
      executablePrefix: ['-n', '10', 'claude'],
      nice: true,
    };
    chunks = stage === 'pilot' ? chunkSchedule(buildSchedule(ids), 16) : [calibrationBatch(qf.questions).jobs];
    runOne = async (job) => {
      const j: Job = { jobId: job.jobId, probe: `angular-${stage}`, config: job.config, questionId: job.questionId, run: job.run, maxBudgetUsd: SESSION_BUDGET_USD };
      const { record, rawStream } = await runJob(j, deps);
      const text = fs.existsSync(rawStream) ? fs.readFileSync(rawStream, 'utf8') : '';
      const sessionRepo = path.join(scratch, 'sessions', job.jobId, 'repo');
      const roots = [sessionRepo, path.join(fs.realpathSync.native(scratch), 'sessions', job.jobId, 'repo')];
      return { ...toPilotRecord(job, record), questionId: job.questionId, config: job.config, run: job.run, toolCalls: record.toolCalls, byTool: record.byTool, wallMs: record.wallMs, pilot: compare(job.questionId, text, roots) } as PilotRecord;
    };
  }
  const result = await runChunks({
    chunks,
    done: doneIds,
    runOne,
    authOk: claudeAuthOk,
    capUsd,
    spentBefore,
    expectedVersion: CLAUDE_VERSION,
    concurrency: concurrency === 2 ? 2 : 1,
    onRecord: (rec) => {
      const line = `${JSON.stringify(rec)}\n`;
      fs.appendFileSync(recordsFile, line);
      fs.appendFileSync(ledger, line);
      process.stdout.write(`${rec.jobId} ${rec.status} billable=${String(rec.usage.billable)} cost=${String(rec.costUsd)} 5h=${String(rec.rate.fiveHour)} 7d=${String(rec.rate.sevenDay)}\n`);
    },
  });
  if (result.stoppedAt !== null) {
    process.stdout.write(`STOP in chunk ${String(result.stoppedAt + 1)}: ${result.reasons.join('; ')}\n`);
    process.exitCode = 3;
    return;
  }
  if (stage === 'calibration') process.stdout.write(`${JSON.stringify(calibrationSummary(readLines<PilotRecord>(recordsFile)), null, 2)}\n`);
  process.stdout.write(`done: ${String(result.records.length)} sessions, ${result.spentUsd.toFixed(2)} USD notional\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      launch: { type: 'boolean', default: false },
      stage: { type: 'string' },
      corpus: { type: 'string' },
      out: { type: 'string' },
      scratch: { type: 'string' },
      ledger: { type: 'string' },
      repo: { type: 'string' },
      questions: { type: 'string' },
      answers: { type: 'string' },
      'cap-usd': { type: 'string' },
      concurrency: { type: 'string', default: '1' },
    },
  });
  const capUsd = parseCap(values['cap-usd']);
  const concurrency = Number(values.concurrency);
  if (concurrency !== 1 && concurrency !== 2) throw new Error('--concurrency must be 1 or 2');
  if (values['dry-run']) {
    const qf = JSON.parse(fs.readFileSync(values.questions ?? path.join(DOCS, 'pilot-questions.json'), 'utf8')) as QuestionFile;
    process.stdout.write(renderDryRun({ questions: qf.questions, capUsd, concurrency, model: MODEL, claudeVersion: CLAUDE_VERSION }));
    return;
  }
  if (!values.launch) throw new Error('refusing to run sessions without --launch (use --dry-run to print the plan)');
  await launch(values);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
