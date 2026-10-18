import { z } from 'zod';
import { CategorySchema } from './questions.ts';

/** The two eval arms (D-05): atlas with its skill and tools, and the grep-only baseline. */
export const ArmSchema = z.enum(['atlas', 'grep']);
export type Arm = z.infer<typeof ArmSchema>;

/** How a session ended. Anything but `ok` is a failed session: it counts as incorrect and keeps its tokens. */
export const StatusSchema = z.enum(['ok', 'error', 'timeout', 'budget', 'killed']);
export type SessionStatus = z.infer<typeof StatusSchema>;

const count = z.number().int().nonnegative();

export const ResultRowSchema = z.strictObject({
  questionId: z.string().min(1),
  category: CategorySchema,
  arm: ArmSchema,
  run: z.number().int().positive(),
  status: StatusSchema,
  answered: z.enum(['found', 'not_found', 'none']),
  correct: z.boolean(),
  citation: z.strictObject({
    applicable: z.boolean(),
    total: count,
    verified: count,
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
});
export type ResultRow = z.infer<typeof ResultRowSchema>;
