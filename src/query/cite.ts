/**
 * Citations and fenced line text, built the one way every code tool builds them (QRY-01, QRY-05): a citation
 * carries structure only (path, position, confidence, debug handle and a reference to its text), and the matched
 * source line, when there is one, goes into `untrusted_text` inside the response's nonce fence.
 */
import type { Citation, Confidence, Span, UntrustedEntry } from '../facts/index.ts';
import { FIELD_MAX_CHARS, fenceText, normalizeText } from './fence.ts';
import type { LineReader, LineText } from './text.ts';

/** Structured repo text (a name, a kind, a path) made safe to show: invisible and escape characters removed, width capped. */
export const cleanField = (value: string): string => normalizeText(value, FIELD_MAX_CHARS);

export interface CitationInput {
  readonly path: string;
  /** The span in the store's coordinates (0-based); the citation shows 1-based positions. */
  readonly span: Span;
  readonly confidence: Confidence;
  /** The opaque handle `gsd-atlas explain` resolves. */
  readonly debug: string;
  /** The text of the line the span starts on, or `unavailable`. */
  readonly line: LineText;
}

/** Citations and `untrusted_text` entries of one response, numbered in the order they were added. */
export interface Citations {
  /** Add one citation and return its id. A line with text also adds an entry. */
  add(input: CitationInput): string;
  readonly citations: readonly Citation[];
  readonly entries: readonly UntrustedEntry[];
  /** True when some citation has no text because its line could not be trusted: the answer is `stale`. */
  lacksText(): boolean;
}

export function createCitations(nonce: string, lineTextMaxChars: number): Citations {
  const citations: Citation[] = [];
  const entries: UntrustedEntry[] = [];
  let missing = false;
  return {
    add(input) {
      const id = `c${String(citations.length + 1)}`;
      let textRef: string | undefined;
      if (input.line.kind === 'ok') {
        textRef = `ut${String(entries.length + 1)}`;
        entries.push({ ref: textRef, text: fenceText(input.line.text, nonce, lineTextMaxChars) });
      } else {
        missing = true;
      }
      citations.push({
        id,
        path: cleanField(input.path),
        line: input.span.startLine + 1,
        col: input.span.startColumn + 1,
        endLine: input.span.endLine + 1,
        endCol: input.span.endColumn + 1,
        confidence: input.confidence,
        debug: input.debug,
        ...(textRef === undefined ? {} : { text_ref: textRef }),
      });
      return id;
    },
    citations,
    entries,
    lacksText: () => missing,
  };
}

/**
 * The line text of an item, read once however many times a response is rebuilt while the budget is measured.
 * The key is the item itself, so two items on one line read it twice (the reader caches the file, not the line).
 */
export function memoLineText<K extends object>(lines: LineReader): (key: K, path: string, span: Span) => Promise<LineText> {
  const known = new Map<K, Promise<LineText>>();
  return (key, path, span) => {
    const found = known.get(key);
    if (found !== undefined) return found;
    const pending = lines.lineAt(path, span);
    known.set(key, pending);
    return pending;
  };
}
