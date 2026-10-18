import { compute, helper } from './lib.cjs';

// The require below is invisible to the checker; ADR #2 §3 explains why the oracle follows it.
export function useTyped(): number {
  return compute(2) + helper();
}

// adr 0003 has no file in docs/adr, so this citation stays unresolved.
export function useRequire(): number {
  // `require` is deliberately undeclared (types: []), so its result is an error type.
  const { compute: calc } = require('./lib.cjs');
  return calc(3);
}

function unrelated(): number {
  function compute(n: number): number {
    return n;
  }
  return compute(4);
}

export const note = 'compute is only text here, see ADR-9 for nothing';
export const unrelatedResult = unrelated();
