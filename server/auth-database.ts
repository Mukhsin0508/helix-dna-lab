import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuthDatabase, AuthResult, AuthStatement, AuthValue } from '../shared/auth-database.ts';

class SqliteAuthStatement implements AuthStatement {
  constructor(readonly connection: DatabaseSync, readonly sql: string, readonly values: AuthValue[] = []) {}
  bind(...values: AuthValue[]): AuthStatement { return new SqliteAuthStatement(this.connection, this.sql, values); }
  async first<T>(): Promise<T | null> { return (this.connection.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async run(): Promise<AuthResult> { return { meta: { changes: Number(this.connection.prepare(this.sql).run(...this.values).changes) } }; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.connection.prepare(this.sql).all(...this.values) as T[] }; }
}

export class SqliteAuthDatabase implements AuthDatabase {
  private readonly connection: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.connection = new DatabaseSync(path);
    this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  }
  prepare(sql: string): AuthStatement { return new SqliteAuthStatement(this.connection, sql); }
  async batch(statements: AuthStatement[]): Promise<AuthResult[]> {
    const own = statements.map(statement => {
      if (!(statement instanceof SqliteAuthStatement) || statement.connection !== this.connection) throw new Error('A batch must use statements from its own database.');
      return statement;
    });
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      // No await inside a transaction: concurrent tasks cannot interleave on this connection.
      const results = own.map(statement => ({ meta: { changes: Number(this.connection.prepare(statement.sql).run(...statement.values).changes) } }));
      this.connection.exec('COMMIT');
      return results;
    } catch (error) {
      if (this.connection.isTransaction) this.connection.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void { this.connection.close(); }
}

export function createAuthDatabase(path: string): SqliteAuthDatabase { return new SqliteAuthDatabase(path); }
