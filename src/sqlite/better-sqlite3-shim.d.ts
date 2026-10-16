/**
 * Minimal declarations for the members the adapter uses: better-sqlite3 ships no types and the build runs
 * with strict settings. Add a member here only when the adapter needs it.
 */
declare module 'better-sqlite3' {
  export interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  }

  export interface RunInfo {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export interface Statement {
    readonly reader: boolean;
    safeIntegers(enabled?: boolean): this;
    run(...params: unknown[]): RunInfo;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export default class Database {
    constructor(filename: string, options?: Options);
    exec(sql: string): this;
    prepare(sql: string): Statement;
    close(): this;
  }
}
