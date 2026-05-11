declare module 'better-sqlite3' {
  class Database {
    constructor(filename: string, options?: unknown);
    exec(sql: string): void;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    prepare(sql: string): Database.Statement;
  }

  namespace Database {
    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }

    interface Statement {
      run(...params: unknown[]): RunResult;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    }
  }

  export default Database;
}
