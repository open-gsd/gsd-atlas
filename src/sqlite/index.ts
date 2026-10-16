/**
 * SQLite driver kit: one thin layer over node:sqlite and better-sqlite3. Private to fact-store, metrics
 * and sdk (boundary lint). There is no `loadExtension` and no contract suite here; the contract is test
 * code and is imported only by this module's own driver tests.
 */
export { openDatabase, loadDriver, selfTest } from './open.ts';
export type { Capabilities, Loaders } from './open.ts';
export { DbError, DriverUnsupportedError, IntegerOutOfRangeError } from './errors.ts';
export type { DbErrorCode, DriverUnsupportedCode } from './errors.ts';
export { PRAGMA_ALLOWLIST } from './driver.ts';
export type {
  BigIntMode,
  Db,
  DriverModule,
  DriverName,
  OpenOptions,
  PragmaName,
  Row,
  RunResult,
  SqlValue,
  Statement,
} from './driver.ts';
