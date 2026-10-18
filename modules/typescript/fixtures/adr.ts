// Decision record: ADR-2143 §3 covers the loader.

/**
 * Loads the data. See ADR #3473 for the format.
 */
export function load(): number {
  /* Retry rules follow the
     adr-0001 decision and
     stay unchanged. */
  const value = 1; // see ADR 12
  return value;
}

// ADR-7 and ADR-8 cover both halves.
const note = "ADR-9";
const memo = `ADR-10 ${note}`;

// ADR-5057 Phase 10 is the history.
// quadr-5 is not a mention.
