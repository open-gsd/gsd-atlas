/**
 * Matched line text (D-10). The store holds no source text, so Query reads the line from disk through
 * Source Tree `readText` (confined to the worktree, no symlink escape, size capped). A file is read once per
 * request. Anything that makes the line untrustworthy as the one the fact points at (the path is listed as
 * stale, the file is gone or unreadable, the file is shorter than the span) yields no text for that result.
 */
import type { Span } from '../facts/index.ts';
import type { QueryDeps } from './types.ts';

export type LineText =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'unavailable' };

export interface LineReader {
  /** The text of the line `span` starts on, with any BOM and one trailing carriage return removed. */
  lineAt(path: string, span: Span): Promise<LineText>;
}

const UNAVAILABLE: LineText = { kind: 'unavailable' };

export function createLineReader(port: QueryDeps['text'], worktree: string, stalePaths: ReadonlySet<string>): LineReader {
  const files = new Map<string, Promise<readonly string[] | null>>();

  const load = (path: string): Promise<readonly string[] | null> => {
    const known = files.get(path);
    if (known !== undefined) return known;
    const pending = port.readText(worktree, path).then(
      (result) => {
        if (result.kind !== 'ok') return null;
        // The engine strips a leading BOM before parsing, so line 0 columns already exclude it.
        const text = result.text.charCodeAt(0) === 0xfeff ? result.text.slice(1) : result.text;
        return text.split('\n');
      },
      () => null,
    );
    files.set(path, pending);
    return pending;
  };

  return {
    async lineAt(path, span) {
      if (stalePaths.has(path)) return UNAVAILABLE;
      const lines = await load(path);
      const raw = lines?.[span.startLine];
      if (raw === undefined) return UNAVAILABLE;
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (span.startColumn > line.length) return UNAVAILABLE;
      return { kind: 'ok', text: line };
    },
  };
}
