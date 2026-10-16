// Pinned-corpus fetch helper. RED stub: plan 02-08 task 3 replaces this with the implementation.

export interface FetchCorpusOptions {
  readonly id: string;
  readonly destination: string;
  readonly remote?: string;
  readonly manifest?: unknown;
}

export interface FetchedCorpus {
  readonly dir: string;
  readonly sha: string;
}

export function corpusRemote(_entry: { readonly repo: string }): string {
  return '';
}

export function fetchCorpus(_options: FetchCorpusOptions): Promise<FetchedCorpus> {
  return Promise.reject(new Error('not implemented'));
}
