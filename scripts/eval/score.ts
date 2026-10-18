import { z } from 'zod';

import type { OracleContext } from './oracle.ts';
import type { AnswerKey, Question } from './questions.ts';

// RED stub (plan 03-07, task 1): the exported surface with no behaviour yet.

export const LINE_SLACK = 2;

export const AnswerSchema = z.never();
export type Answer = {
  answer: 'found' | 'not_found';
  items: { file: string; line?: number; symbol?: string }[];
  summary: string;
};

export type Extracted = { ok: true; answer: Answer } | { ok: false; reason: string; detail?: string };

export interface ScoredItem {
  file: string;
  line?: number;
  symbol?: string;
}

export interface CitationFailure {
  file: string;
  line: number;
  reason: string;
}

export interface CitationScore {
  applicable: boolean;
  total: number;
  verified: number;
  hasVerifiable: boolean;
  failures: CitationFailure[];
}

export interface Scored {
  correct: boolean;
  reason: string;
  answered: 'found' | 'not_found' | 'none';
  matched: ScoredItem[];
  missing: ScoredItem[];
  extra: ScoredItem[];
  citation: CitationScore;
}

export function extractAnswer(_resultText: string): Extracted {
  return { ok: false, reason: 'not implemented' };
}

export async function scoreAnswer(
  _question: Question,
  _key: AnswerKey,
  _answerText: string,
  _ctx: OracleContext,
): Promise<Scored> {
  return {
    correct: false,
    reason: 'not implemented',
    answered: 'none',
    matched: [],
    missing: [],
    extra: [],
    citation: { applicable: false, total: 0, verified: 0, hasVerifiable: false, failures: [] },
  };
}
