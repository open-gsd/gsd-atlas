/** Failure classes of the SQLite driver kit. Plain classes with explicit fields (erasable syntax only). */

export type DbErrorCode = 'busy' | 'constraint' | 'readonly' | 'other';

/** A SQLite error mapped from the driver's own error type, so callers never see driver-specific errors. */
export class DbError extends Error {
  readonly code: DbErrorCode;
  /** The SQLite primary result code (for example 5 for SQLITE_BUSY), when the driver reported one. */
  readonly sqliteCode: number | undefined;

  constructor(code: DbErrorCode, message: string, sqliteCode?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DbError';
    this.code = code;
    this.sqliteCode = sqliteCode;
  }
}

/**
 * An INTEGER column held a value that a JavaScript number cannot represent exactly. Open the database with
 * `bigints: 'bigint'` to read such values, never accept a silently rounded one.
 */
export class IntegerOutOfRangeError extends RangeError {
  readonly value: bigint;

  constructor(value: bigint) {
    super(
      `integer ${value.toString()} is outside the exact range of a JavaScript number; open the database with bigints: 'bigint'`,
    );
    this.name = 'IntegerOutOfRangeError';
    this.value = value;
  }
}

export type DriverUnsupportedCode = 'nul_truncation' | 'not_installed' | 'unsupported_node' | 'self_test_failed';

/** A SQLite driver cannot be used on this machine. `code` says why. */
export class DriverUnsupportedError extends Error {
  readonly code: DriverUnsupportedCode;

  constructor(code: DriverUnsupportedCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DriverUnsupportedError';
    this.code = code;
  }
}
