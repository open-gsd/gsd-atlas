import type { OracleContext } from './oracle.ts';
import type { Category, KeySpec } from './questions.ts';

/**
 * RED stub for plan 03-09 task 1: the exported shapes and inert behaviour, so the tests fail on
 * their assertions and not on a load error. Replaced by the implementation in the next commit.
 */

export type ExportKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const';

export interface ExportEntry {
  symbol: string;
  file: string;
  line: number;
  kind: ExportKind;
  calls: number;
  callerFiles: number;
  refs: number;
  nameCount: number;
}

export interface TypeEntry {
  symbol: string;
  file: string;
  line: number;
  kind: 'class' | 'interface';
  subtypes: number;
  nameCount: number;
}

export interface LibTypeEntry {
  symbol: string;
  subtypes: number;
}

export interface EmitEntry {
  source: string;
  outputs: string[];
  requirers: number;
  requirerFiles: number;
}

export interface AdrEntry {
  number: number;
  files: string[];
  citations: number;
  citingFiles: number;
}

export interface AdrOfEntry {
  symbol: string;
  file: string;
  line: number;
  adrs: number[];
  nameCount: number;
}

export interface NearMiss {
  name: string;
  from: string;
  file: string;
}

export interface Census {
  exports: ExportEntry[];
  types: TypeEntry[];
  libTypes: LibTypeEntry[];
  emits: EmitEntry[];
  adrs: AdrEntry[];
  adrOf: AdrOfEntry[];
  nearMisses: NearMiss[];
}

export interface Candidate {
  category: Category;
  group: string;
  identity: string;
  name: string;
  file: string;
  key: KeySpec;
  facts: Record<string, number | string>;
}

export interface SampleOptions {
  seed: number;
  skip: number;
}

export function mulberry32(_seed: number): () => number {
  return () => 0;
}

export async function buildCensus(_ctx: OracleContext): Promise<Census> {
  return { exports: [], types: [], libTypes: [], emits: [], adrs: [], adrOf: [], nearMisses: [] };
}

export function orderCandidates(_census: Census, _category: Category, _seed: number): Candidate[] {
  return [];
}

export function sample(_census: Census, _category: Category, _count: number, _options: SampleOptions): Candidate[] {
  return [];
}
