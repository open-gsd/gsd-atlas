import type { BigIntMode, Row, SqlValue } from './driver.ts';
import { IntegerOutOfRangeError } from './errors.ts';

/** Both drivers are configured to hand back every INTEGER as a bigint; this converts per the `bigints` option. */
export function integerOut(value: bigint, mode: BigIntMode): number | bigint {
  if (mode === 'bigint') return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new IntegerOutOfRangeError(value);
  }
  return Number(value);
}

/** Convert one raw column value: bigints per mode, Buffer to a plain Uint8Array so deepStrictEqual agrees across drivers. */
export function valueOut(value: unknown, mode: BigIntMode): SqlValue {
  if (typeof value === 'bigint') return integerOut(value, mode);
  if (value instanceof Uint8Array) {
    // A Buffer is a Uint8Array subclass; copy into the plain class so rows look identical on every driver.
    return value.constructor === Uint8Array ? value : new Uint8Array(value);
  }
  return value as SqlValue;
}

/**
 * Convert a raw row (null prototype on node:sqlite) to a plain object. `Object.fromEntries` defines own
 * properties, so a column named `__proto__` cannot reach the prototype.
 */
export function rowOut(raw: unknown, mode: BigIntMode): Row {
  const entries = Object.entries(raw as Record<string, unknown>).map(
    ([key, value]): [string, SqlValue] => [key, valueOut(value, mode)],
  );
  return Object.fromEntries(entries);
}

const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);

/**
 * Check a bound parameter. Only null, number, bigint, string and Uint8Array are accepted: node:sqlite binds
 * `undefined` and booleans silently while better-sqlite3 refuses some of them, and the kit must behave alike.
 */
export function checkParam(value: unknown, index: number): SqlValue {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new TypeError(`parameter ${index + 1} is NaN; SQLite cannot bind NaN`);
    return value;
  }
  if (typeof value === 'bigint') {
    if (value > INT64_MAX || value < INT64_MIN) {
      throw new IntegerOutOfRangeError(value);
    }
    return value;
  }
  if (value instanceof Uint8Array) return value;
  throw new TypeError(
    `parameter ${index + 1} has unsupported type ${value === undefined ? 'undefined' : typeof value}; bind null, number, bigint, string or Uint8Array`,
  );
}

export function checkParams(params: readonly unknown[]): SqlValue[] {
  return params.map((value, index) => checkParam(value, index));
}

const PRAGMA_VALUE = /^[A-Za-z_]+$/;
const SAVEPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A pragma value is a bare word (`wal`, `NORMAL`) or a finite integer; nothing else reaches the SQL text. */
export function checkPragmaValue(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError('pragma value must be an integer');
    return String(value);
  }
  if (typeof value !== 'string' || !PRAGMA_VALUE.test(value)) {
    throw new TypeError(`pragma value ${JSON.stringify(value)} must match ^[A-Za-z_]+$ or be an integer`);
  }
  return value;
}

export function checkSavepointName(name: string): string {
  if (typeof name !== 'string' || !SAVEPOINT_NAME.test(name)) {
    throw new TypeError(`savepoint name ${JSON.stringify(name)} must match ^[A-Za-z_][A-Za-z0-9_]*$`);
  }
  return name;
}
