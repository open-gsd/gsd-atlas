// Pure helpers for the design probe (atlas output size versus a one-call explore tool). No I/O.

export interface KeyItem {
  readonly file: string;
  readonly line?: number;
  readonly symbol?: string;
}

export interface SetScore {
  readonly matched: number;
  readonly missing: number;
  readonly extra: number;
  readonly exact: boolean;
  readonly recall: number;
}

/** The estimate the atlas metrics use: characters (here bytes) divided by four. Not a tokenizer. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Repo-relative `.ts` paths (not `.d.ts`) that start with `prefix` in `text`, once each, sorted by code unit. */
export function extractFiles(text: string, prefix: string, stripRoot?: string): string[] {
  const body = stripRoot === undefined ? text : text.split(stripRoot).join('');
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}[A-Za-z0-9_./@+-]*?\\.ts(?![A-Za-z0-9_])`, 'g');
  const found = new Set<string>();
  for (const match of body.matchAll(pattern)) {
    if (!match[0].endsWith('.d.ts')) found.add(match[0]);
  }
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The set an answer is compared on: files, or `file#symbol` for the file+symbol granularity. */
export function fileSetOfKey(items: readonly KeyItem[], granularity: string): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    out.add(granularity === 'file+symbol' ? `${item.file}#${item.symbol ?? ''}` : item.file);
  }
  return out;
}

export function scoreSets(found: ReadonlySet<string>, key: ReadonlySet<string>): SetScore {
  let matched = 0;
  for (const value of key) if (found.has(value)) matched += 1;
  const missing = key.size - matched;
  const extra = found.size - matched;
  return { matched, missing, extra, exact: missing === 0 && extra === 0, recall: key.size === 0 ? 1 : matched / key.size };
}
