/**
 * The pre-registration (D-04, D-09, D-23, EVL-02): a markdown file with one machine-readable block that records
 * every analysis parameter and the sha256 of every file that decides the claim. The freeze is mechanical: a later
 * edit to a registered file, or to a registered parameter, shows up as a hash or schema failure in verify-prereg.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';

/** The fenced block label that holds the registration. */
export const PREREG_BLOCK_LABEL = 'prereg-json';

/** Where the committed pre-registration lives. */
export const DEFAULT_PREREG_PATH = 'docs/eval/preregistration.md';

/** The skill file Stage B hashes (D-09, D-23). */
export const SKILL_PATH = 'skills/gsd-atlas/SKILL.md';

/** The files the Stage A freeze hashes: the question set and answer keys, the oracle, scorer, harness and analysis. */
export const STAGE_A_FILES: readonly string[] = [
  'scripts/eval/questions/gsd-core.questions.json',
  'scripts/eval/questions/gsd-core.answers.json',
  'scripts/eval/questions.ts',
  'scripts/eval/oracle.ts',
  'scripts/eval/score.ts',
  'scripts/eval/answer-schema.json',
  'scripts/eval/stats.ts',
  'scripts/eval/rows.ts',
  'scripts/eval/analyze.ts',
  'scripts/eval/prereg.ts',
  'scripts/eval/claude-session.ts',
  'scripts/eval/arms.ts',
  'scripts/eval/harness.ts',
  'scripts/eval/schedule.ts',
  'scripts/eval/results.ts',
  'scripts/eval/prepare-corpus.ts',
];

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lower-case hex characters');
const gitId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'must be a 40 or 64 character lower-case hex id');

export const PreregSchema = z
  .strictObject({
    stage: z.enum(['A', 'B']),
    status: z.enum(['Draft', 'Frozen']),
    params: z.strictObject({
      /** The non-inferiority margin in percentage points. */
      marginPoints: z.number().positive(),
      /** The one-sided confidence level of the bootstrap bound (0.95: the 5th percentile is the lower bound). */
      intervalLevel: z.number().gt(0.5).lt(1),
      resamples: z.number().int().positive(),
      seed: z.number().int(),
      runsPerCell: z.number().int().positive(),
      /** The EVL-03 citation threshold (0.8). */
      citationRate: z.number().gt(0).lte(1),
      /** Which figure the threshold is judged on. The user's explicit choice (OQ4); required, with no default. */
      citationJudgedOn: z.enum(['point_estimate', 'wilson_lower_bound']),
      /** The z of the Wilson interval (1.96). */
      wilsonZ: z.number().positive(),
      /** `point`: fewer tokens when the observed difference is below zero. `upper-bound`: when the upper percentile is. */
      tokenCriterion: z.enum(['point', 'upper-bound']),
      /** The only registered rule: a failed session counts as incorrect and keeps its tokens. */
      failureRule: z.literal('incorrect-keep-tokens'),
      concurrency: z.number().int().positive(),
      maxBudgetUsdPerSession: z.number().positive(),
      sessionWallClockMs: z.number().int().positive(),
      model: z.string().min(1),
      claudeVersion: z.string().min(1),
      corpusSha: gitId,
      npmCiRan: z.boolean(),
    }),
    /** Registered path (relative to the repository root, forward slashes) to the sha256 of its LF-normalised bytes. */
    files: z.record(z.string().min(1), sha256),
    questionSet: z.strictObject({
      count: z.number().int().positive(),
      byCategory: z.record(z.string().min(1), z.number().int().nonnegative()),
    }),
    stageB: z.strictObject({ skillSha256: sha256, atlasCommit: gitId }).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.stage === 'B' && value.stageB === undefined) {
      ctx.addIssue({ code: 'custom', message: 'a Stage B registration needs the stageB record', path: ['stageB'] });
    }
    if (value.stage === 'A' && value.stageB !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'a Stage A registration must not carry a stageB record', path: ['stageB'] });
    }
    const total = Object.values(value.questionSet.byCategory).reduce((a, b) => a + b, 0);
    if (total !== value.questionSet.count) {
      ctx.addIssue({
        code: 'custom',
        message: `byCategory sums to ${String(total)} but count is ${String(value.questionSet.count)}`,
        path: ['questionSet', 'byCategory'],
      });
    }
  });
export type Prereg = z.infer<typeof PreregSchema>;

/**
 * The bytes with every CRLF pair replaced by LF, so a Windows checkout with `core.autocrlf` hashes like a Linux
 * one (T-03-53). A lone CR is left alone.
 */
export function normalizeLineEndings(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[n] = bytes[i] as number;
    n += 1;
  }
  return out.subarray(0, n);
}

/** The lower-case hex sha256 of the file bytes after CRLF is normalised to LF: the registered form of a hash. */
export function hashFile(file: string): string {
  return createHash('sha256').update(normalizeLineEndings(fs.readFileSync(file))).digest('hex');
}

/** The text of every fenced block with the given label; throws when a labelled block is never closed. */
export function extractBlocks(text: string, label: string, source: string): string[] {
  const opening = `\`\`\`${label}`;
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (current === null) {
      if (trimmed === opening) current = [];
    } else if (trimmed === '```') {
      blocks.push(current.join('\n'));
      current = null;
    } else {
      current.push(line);
    }
  }
  if (current !== null) throw new Error(`${source}: the ${label} block is not closed`);
  return blocks;
}

/**
 * Reads the pre-registration at `file`: exactly one fenced block labelled `prereg-json`, parsed with
 * `PreregSchema`. Zero blocks, two blocks, invalid JSON and any schema violation throw an error that names the
 * file and, for a schema violation, each offending field (for example `params.citationJudgedOn`, which has no
 * default and so can only come from a registered, human-confirmed block).
 */
export function readPrereg(file: string): Prereg {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const blocks = extractBlocks(text, PREREG_BLOCK_LABEL, file);
  if (blocks.length === 0) throw new Error(`${file}: no ${PREREG_BLOCK_LABEL} block found`);
  if (blocks.length > 1) throw new Error(`${file}: ${String(blocks.length)} ${PREREG_BLOCK_LABEL} blocks found, exactly one is allowed`);
  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0] as string);
  } catch (error) {
    throw new Error(`${file}: the ${PREREG_BLOCK_LABEL} block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const parsed = PreregSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`${file}: invalid ${PREREG_BLOCK_LABEL} block: ${issues.join('; ')}`);
  }
  return parsed.data;
}
