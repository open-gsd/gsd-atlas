import type { DegradedCode } from './degraded.ts';

/**
 * How current an answer is. `seq` is monotonic per worktree and advances only after a commit.
 * `stalePaths` lists paths the answer may not reflect yet; reads report them and never wait.
 */
export interface Watermark {
  readonly seq: number;
  readonly stalePaths: readonly string[];
}

/**
 * The result of every Fact Store read (fact-store-interface ADR decision 3).
 *
 * Reads never throw for missing data (D-17): a degraded read returns empty `data` plus a code in
 * `degraded`. Only structural errors such as an unknown worktree or a closed store throw.
 */
export interface Answer<T> {
  readonly data: T;
  readonly watermark: Watermark;
  readonly degraded?: readonly DegradedCode[];
}
