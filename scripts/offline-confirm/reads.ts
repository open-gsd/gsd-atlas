// Measurement C: what a session does with files after an atlas call. A Read (or a shell file read) of
// a file atlas had just returned is the "matched line was not enough" signal of the design note.
import { isAtlasCall, repoRelative } from './stream.ts';
import type { Call, Session } from './stream.ts';

export type Category = 'read' | 'bash-file-read' | 'grep-file' | 'grep-search';

export interface Follow {
  readonly call: Call;
  readonly category: Category;
  /** Repo-relative file operands found in the call. */
  readonly files: readonly string[];
  /** Some file operand is a path an earlier atlas result returned. */
  readonly targetsReturned: boolean;
  /** ... and the call is at most two assistant turns after the atlas call that returned it. */
  readonly withinTwoTurns: boolean;
}

const READERS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'awk', 'less', 'more', 'bat']);
const GREPPERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);
const PATH_LIKE = /^[\w@~./+-]*[\w@-]\.[A-Za-z0-9]{1,6}$/;

/** Splits a shell command line into tokens, keeping quoted text together and dropping the quotes. */
export function tokenise(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let any = false;
  for (const char of segment) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      any = true;
    } else if (/\s/.test(char)) {
      if (current !== '' || any) tokens.push(current);
      current = '';
      any = false;
    } else {
      current += char;
    }
  }
  if (current !== '' || any) tokens.push(current);
  return tokens;
}

/** The command segments of a shell line, split on `;`, `&&`, `||`, `|` and line breaks outside quotes. */
export function segmentsOf(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ';' || char === '\n' || char === '|' || (char === '&' && command[i + 1] === '&')) {
      if (char === '&' || (char === '|' && command[i + 1] === '|')) i += 1;
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((segment) => segment.trim()).filter((segment) => segment !== '');
}

interface Classified {
  readonly category: Category;
  readonly operands: string[];
}

/** Classifies one Bash command: a shell file read, a grep, or neither (null). */
export function classifyBash(command: string): Classified | null {
  let best: Classified | null = null;
  for (const segment of segmentsOf(command)) {
    const tokens = tokenise(segment);
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] as string)) index += 1;
    const utility = (tokens[index] ?? '').split('/').pop() ?? '';
    const operands = tokens.slice(index + 1).filter((token) => !token.startsWith('-'));
    if (READERS.has(utility)) {
      const files = operands.filter((token) => PATH_LIKE.test(token));
      if (files.length > 0) return { category: 'bash-file-read', operands: files };
    } else if (GREPPERS.has(utility)) {
      // The first operand is the pattern; a later operand with a file extension is a file operand.
      const files = operands.slice(1).filter((token) => PATH_LIKE.test(token));
      if (files.length > 0 && (best === null || best.category === 'grep-search')) best = { category: 'grep-file', operands: files };
      else if (best === null) best = { category: 'grep-search', operands: [] };
    }
  }
  return best;
}

/** Paths an atlas result returned, by the turn of the call that returned them (earliest turn kept). */
export function returnedPaths(call: Call): string[] {
  if (call.result === null) return [];
  let envelope: unknown;
  try {
    envelope = JSON.parse(call.result);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const data = (envelope as { data?: unknown } | null)?.data;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'path' && typeof item === 'string') found.add(item);
        else visit(item);
      }
    }
  };
  visit(data);
  return [...found];
}

export interface ReadAnalysis {
  readonly atlasCalls: number;
  readonly follows: Follow[];
}

export function analyseReads(session: Session): ReadAnalysis {
  const atlas = session.calls.filter(isAtlasCall);
  const follows: Follow[] = [];
  if (atlas.length === 0) return { atlasCalls: 0, follows };
  const firstOrder = Math.min(...atlas.map((call) => call.order));
  for (const call of session.calls) {
    if (call.order <= firstOrder) continue;
    let category: Category;
    let raw: string[] = [];
    if (call.name === 'Read') {
      category = 'read';
      raw = typeof call.input.file_path === 'string' ? [call.input.file_path] : [];
    } else if (call.name === 'Grep') {
      const target = typeof call.input.path === 'string' ? call.input.path : '';
      raw = target === '' ? [] : [target];
      category = raw.length > 0 && PATH_LIKE.test(target) ? 'grep-file' : 'grep-search';
    } else if (call.name === 'Bash' && typeof call.input.command === 'string') {
      const classified = classifyBash(call.input.command);
      if (classified === null) continue;
      category = classified.category;
      raw = classified.operands;
    } else {
      continue;
    }
    const files = raw.map((operand) => repoRelative(operand, session.cwd));
    let targetsReturned = false;
    let within = false;
    for (const earlier of atlas) {
      if (earlier.order >= call.order || earlier.turn >= call.turn) continue;
      const paths = returnedPaths(earlier);
      if (files.some((file) => paths.includes(file))) {
        targetsReturned = true;
        if (call.turn - earlier.turn <= 2) within = true;
      }
    }
    follows.push({ call, category, files, targetsReturned, withinTwoTurns: within });
  }
  return { atlasCalls: atlas.length, follows };
}

export interface ReadSummary {
  readonly sessions: number;
  readonly calledSessions: number;
  /** Per category: follow-up calls after an atlas call, how many target a returned file, how many within two turns. */
  readonly byCategory: Record<Category, { after: number; returned: number; within: number }>;
  /** Called sessions with any Read or shell file read after an atlas call. */
  readonly sessionsAnyReadAfter: number;
  /** Called sessions with any follow-up of the four categories (including a recursive grep) after an atlas call. */
  readonly sessionsAnyFollow: number;
  /** Called sessions with a Read or shell file read of a returned file within two turns: the rule's signal. */
  readonly sessionsSignal: number;
  /** The same, counting a grep with an explicit returned file as well. */
  readonly sessionsSignalWithGrepFile: number;
}

export function summariseReads(sessions: readonly Session[]): ReadSummary {
  const byCategory: Record<Category, { after: number; returned: number; within: number }> = {
    read: { after: 0, returned: 0, within: 0 },
    'bash-file-read': { after: 0, returned: 0, within: 0 },
    'grep-file': { after: 0, returned: 0, within: 0 },
    'grep-search': { after: 0, returned: 0, within: 0 },
  };
  let called = 0;
  let anyRead = 0;
  let anyFollow = 0;
  let signal = 0;
  let signalGrep = 0;
  for (const session of sessions) {
    const analysis = analyseReads(session);
    if (analysis.atlasCalls === 0) continue;
    called += 1;
    let sawRead = false;
    let sawSignal = false;
    let sawSignalGrep = false;
    for (const follow of analysis.follows) {
      const row = byCategory[follow.category];
      row.after += 1;
      if (follow.targetsReturned) row.returned += 1;
      if (follow.withinTwoTurns) row.within += 1;
      if (follow.category === 'read' || follow.category === 'bash-file-read') {
        sawRead = true;
        if (follow.withinTwoTurns) sawSignal = true;
      }
      if (follow.withinTwoTurns && follow.category !== 'grep-search') sawSignalGrep = true;
    }
    if (analysis.follows.length > 0) anyFollow += 1;
    if (sawRead) anyRead += 1;
    if (sawSignal) signal += 1;
    if (sawSignalGrep) signalGrep += 1;
  }
  return {
    sessions: sessions.length,
    calledSessions: called,
    byCategory,
    sessionsAnyReadAfter: anyRead,
    sessionsAnyFollow: anyFollow,
    sessionsSignal: signal,
    sessionsSignalWithGrepFile: signalGrep,
  };
}
