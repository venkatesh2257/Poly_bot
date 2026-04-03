declare module "sqlite" {
  export interface Database {
    exec(sql: string): Promise<void>;
    run(sql: string, ...params: unknown[]): Promise<unknown>;
    get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
    all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  }
  export function open(opts: { filename: string; driver: unknown }): Promise<Database>;
}

declare module "sqlite3" {
  export class Database {
    constructor(path: string, cb?: (err: Error | null) => void);
  }
  interface Sqlite3 {
    Database: typeof Database;
  }
  const sqlite3: Sqlite3;
  export default sqlite3;
}
