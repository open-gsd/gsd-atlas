// Pure helpers for ADR ratification (FND-09). Node built-ins only.
// RED stub: behaviour is implemented in the GREEN commit.

export const PHASE1_SLUGS: readonly string[] = [];

export interface BrokenLink {
  file: string;
  link: string;
  target: string;
}

export function ratifyText(_text: string, _issueNumber: number, _isoDate: string): string {
  throw new Error('not implemented');
}

export function rewriteReferences(_text: string, _slugToIssue: Readonly<Record<string, number>>): string {
  throw new Error('not implemented');
}

export function findAdrFile(_adrDir: string, _slug: string): string | null {
  throw new Error('not implemented');
}

export function collectLinkFiles(_root: string): string[] {
  throw new Error('not implemented');
}

export function checkRelativeLinks(_root: string, _files: readonly string[]): BrokenLink[] {
  throw new Error('not implemented');
}
