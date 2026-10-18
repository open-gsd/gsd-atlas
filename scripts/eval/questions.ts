import fs from 'node:fs';

import { z } from 'zod';

/**
 * Question and answer-key shapes of the pre-registered eval (EVL-02, D-02).
 *
 * This file is read by the oracle, the scorer and the question files, and its hash is frozen with
 * them at plan 03-16, so a shape change after the freeze means a new registered run. It imports
 * only zod and Node built-ins: an answer key may never depend on the system under test.
 *
 * Paths in every shape are repository-relative POSIX paths (threat T-03-43): no leading slash, no
 * drive letter, no backslash and no `..` segment.
 */

export const GranularitySchema = z.enum(['file', 'file+symbol', 'file+line']);
export type Granularity = z.infer<typeof GranularitySchema>;

export const EqualitySchema = z.enum(['exact-set', 'superset-ok']);
export type Equality = z.infer<typeof EqualitySchema>;

export const CategorySchema = z.enum([
  'callers',
  'references',
  'heritage',
  'emit',
  'adr',
  'impact',
  'definition',
  'abstain',
]);
export type Category = z.infer<typeof CategorySchema>;

export const KIND_NAMES = [
  'callers',
  'references',
  'heritage',
  'emit',
  'emit-consumers',
  'adr-citers',
  'adr-of',
  'definition',
  'impact',
  'abstain',
] as const;
export const KindSchema = z.enum(KIND_NAMES);
export type Kind = z.infer<typeof KindSchema>;

/** The category each key kind belongs to; a question whose category disagrees is rejected. */
export const CATEGORY_OF_KIND: Readonly<Record<Kind, Category>> = {
  callers: 'callers',
  references: 'references',
  heritage: 'heritage',
  emit: 'emit',
  'emit-consumers': 'emit',
  'adr-citers': 'adr',
  'adr-of': 'adr',
  definition: 'definition',
  impact: 'impact',
  abstain: 'abstain',
};

const relPath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes('\\') &&
      !value.split('/').includes('..'),
    { message: 'must be a repository-relative POSIX path' },
  );

const symbolName = z.string().regex(/^[A-Za-z_$][\w$]*$/, 'must be a plain identifier');

const common = { granularity: GranularitySchema, equality: EqualitySchema };

const CallersKey = z.strictObject({
  kind: z.literal('callers'),
  symbol: symbolName,
  definedIn: relPath,
  container: symbolName.optional(),
  ...common,
});

const ReferencesKey = z.strictObject({
  kind: z.literal('references'),
  symbol: symbolName,
  definedIn: relPath,
  container: symbolName.optional(),
  ...common,
});

const HeritageKey = z
  .strictObject({
    kind: z.literal('heritage'),
    symbol: symbolName,
    /** Required unless `lib` is true: the file that declares the class or interface. */
    definedIn: relPath.optional(),
    /** True for a library type such as `Error`, matched by name and a declaration in a lib file. */
    lib: z.boolean().optional(),
    direction: z.enum(['subtypes', 'supertypes']),
    ...common,
  })
  .refine((key) => (key.lib === true) === (key.definedIn === undefined), {
    message: 'heritage needs definedIn, or lib: true and no definedIn',
  });

const EmitKey = z.strictObject({ kind: z.literal('emit'), source: relPath, ...common });

const EmitConsumersKey = z.strictObject({ kind: z.literal('emit-consumers'), source: relPath, ...common });

const AdrCitersKey = z.strictObject({
  kind: z.literal('adr-citers'),
  number: z.number().int().nonnegative(),
  ...common,
});

const AdrOfKey = z.strictObject({
  kind: z.literal('adr-of'),
  symbol: symbolName,
  definedIn: relPath,
  container: symbolName.optional(),
  ...common,
});

const DefinitionKey = z.strictObject({
  kind: z.literal('definition'),
  symbol: symbolName,
  /** When absent the symbol is searched in every file of the program. */
  definedIn: relPath.optional(),
  container: symbolName.optional(),
  ...common,
});

const ImpactKey = z.strictObject({
  kind: z.literal('impact'),
  symbol: symbolName,
  definedIn: relPath,
  container: symbolName.optional(),
  depth: z.number().int().min(1).max(5),
  ...common,
});

const AbstainKey = z.strictObject({
  kind: z.literal('abstain'),
  probe: z.union([
    z.strictObject({ symbol: symbolName }),
    z.strictObject({ adrNoFile: z.number().int().nonnegative() }),
  ]),
  ...common,
});

export const KeySpecSchema = z.discriminatedUnion('kind', [
  CallersKey,
  ReferencesKey,
  HeritageKey,
  EmitKey,
  EmitConsumersKey,
  AdrCitersKey,
  AdrOfKey,
  DefinitionKey,
  ImpactKey,
  AbstainKey,
]);
export type KeySpec = z.infer<typeof KeySpecSchema>;

export const QuestionSchema = z
  .strictObject({
    // `q-` for the scored set, `p-` for the pilot set (plan 03-09); the two never share an id.
    id: z.string().regex(/^[qp]-\d+$/, 'must be q- or p- followed by digits'),
    category: CategorySchema,
    text: z.string().min(1),
    key: KeySpecSchema,
  })
  .superRefine((question, ctx) => {
    if (CATEGORY_OF_KIND[question.key.kind] !== question.category) {
      ctx.addIssue({
        code: 'custom',
        message: `category ${question.category} does not match key kind ${question.key.kind}`,
        path: ['category'],
      });
    }
  });
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionFileSchema = z
  .strictObject({
    corpusId: z.string().min(1),
    corpusSha: z.string().min(1),
    questions: z.array(QuestionSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.questions.forEach((question, index) => {
      if (seen.has(question.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate question id ${question.id}`,
          path: ['questions', index, 'id'],
        });
      }
      seen.add(question.id);
    });
  });
export type QuestionFile = z.infer<typeof QuestionFileSchema>;

/**
 * One element of an answer key. `file` is present on every item except an unresolved ADR citation
 * (`resolved: false`), which names a number that has no ADR file.
 */
export const AnswerItemSchema = z
  .strictObject({
    file: relPath.optional(),
    line: z.number().int().positive().optional(),
    symbol: z.string().min(1).optional(),
    adr: z.number().int().nonnegative().optional(),
    resolved: z.boolean().optional(),
    detail: z.string().min(1).optional(),
  })
  .refine((item) => item.file !== undefined || item.resolved === false, {
    message: 'file is required unless the item is an unresolved ADR citation',
  });
export type AnswerItem = z.infer<typeof AnswerItemSchema>;

export const UnexplainedSchema = z.strictObject({
  file: relPath,
  line: z.number().int().positive(),
  text: z.string(),
});
export type Unexplained = z.infer<typeof UnexplainedSchema>;

export const AnswerKeySchema = z.strictObject({
  questionId: z.string().min(1),
  kind: KindSchema,
  abstain: z.boolean(),
  items: z.array(AnswerItemSchema),
  granularity: GranularitySchema,
  equality: EqualitySchema,
  /** Names that may legitimately appear on a valid cited line. */
  needles: z.array(z.string()),
  /** Textual mentions the compiler-based result neither includes nor classifies; non-empty means ambiguous. */
  unexplained: z.array(UnexplainedSchema),
  /** Counters and flags the author may want to see, e.g. excludedNonComment. */
  notes: z.record(z.string(), z.union([z.number(), z.string()])),
  oracleVersion: z.string().min(1),
});
export type AnswerKey = z.infer<typeof AnswerKeySchema>;

/**
 * How the checkout the keys were computed against was prepared (OQ8): a copy of the preparation
 * record of `prepare-corpus.ts` without its machine-specific `dir`, so the answers file is the same
 * on every machine. Optional because `oracle.ts keys` does not know it; `draft-census.ts stamp` adds it.
 */
export const PreparedRecordCopySchema = z.strictObject({
  corpusId: z.string().min(1),
  sha: z.string().min(1),
  npmCi: z.boolean(),
  typescriptVersion: z.string().min(1).nullable(),
  lockSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
export type PreparedRecordCopy = z.infer<typeof PreparedRecordCopySchema>;

export const AnswerFileSchema = z.strictObject({
  oracleVersion: z.string().min(1),
  repoSha: z.string().min(1),
  preparedRecord: PreparedRecordCopySchema.optional(),
  answers: z.array(AnswerKeySchema),
});
export type AnswerFile = z.infer<typeof AnswerFileSchema>;

/** Reads and validates a question file; throws the zod error (with its message) when invalid. */
export function loadQuestions(file: string): QuestionFile {
  let raw: unknown;
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot read questions file ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return QuestionFileSchema.parse(raw);
}
