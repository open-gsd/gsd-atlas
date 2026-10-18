import { z } from 'zod';
import { CategorySchema } from './questions.ts';

/** The two eval arms (D-05): atlas with its skill and tools, and the grep-only baseline. */
export const ArmSchema = z.enum(['atlas', 'grep']);
export type Arm = z.infer<typeof ArmSchema>;

/** How a session ended. Anything but `ok` is a failed session: it counts as incorrect and keeps its tokens. */
export const StatusSchema = z.enum(['ok', 'error', 'timeout', 'budget', 'killed']);
export type SessionStatus = z.infer<typeof StatusSchema>;

const count = z.number().int().nonnegative();

/**
 * One scored session: a (question, arm, run) cell. Written by the harness and the scorer, read by the analysis.
 * `billableTokens` is the D-06 statistic and must equal input + output + cacheCreation + cacheRead; the schema
 * refuses a row where it does not, so a wrong usage report cannot reach the verdict. A failed session (any status
 * but `ok`) is a row like any other: it has `correct: false` and keeps its tokens.
 */
export const ResultRowSchema = z
  .strictObject({
    questionId: z.string().min(1),
    category: CategorySchema,
    arm: ArmSchema,
    run: z.number().int().positive(),
    status: StatusSchema,
    answered: z.enum(['found', 'not_found', 'none']),
    correct: z.boolean(),
    citation: z.strictObject({
      /** Whether the question expects citations (an abstain question does not). */
      applicable: z.boolean(),
      /** How many file:line citations the answer carries. */
      total: count,
      /** How many of them the scorer verified against the pinned checkout. */
      verified: count,
      /** At least one file:line citation and every cited file:line verified (EVL-03). */
      hasVerifiable: z.boolean(),
    }),
    usage: z.strictObject({
      input: count,
      output: count,
      cacheCreation: count,
      cacheRead: count,
    }),
    billableTokens: count,
    toolCalls: count,
    toolCallsByName: z.record(z.string(), count),
    atlasToolCalls: count,
    wallMs: z.number().nonnegative(),
    costUsd: z.number().nonnegative().nullable(),
  })
  .superRefine((row, ctx) => {
    const sum = row.usage.input + row.usage.output + row.usage.cacheCreation + row.usage.cacheRead;
    if (row.billableTokens !== sum) {
      ctx.addIssue({
        code: 'custom',
        message: `billableTokens ${String(row.billableTokens)} must equal input + output + cacheCreation + cacheRead (${String(sum)})`,
        path: ['billableTokens'],
      });
    }
    if (row.citation.verified > row.citation.total) {
      ctx.addIssue({
        code: 'custom',
        message: `citation.verified ${String(row.citation.verified)} exceeds citation.total ${String(row.citation.total)}`,
        path: ['citation', 'verified'],
      });
    }
  });
export type ResultRow = z.infer<typeof ResultRowSchema>;
