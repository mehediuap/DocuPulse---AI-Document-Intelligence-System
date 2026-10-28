/**
 * Database Connection & Lifecycle Manager
 * Uses better-sqlite3 with WAL mode, foreign key constraints, and automatic migration execution.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { runMigrations } from './migrations.ts';

export class DatabaseClient {
  private static instance: DatabaseClient;
  private db: Database.Database;

  private constructor(dbPath?: string) {
    const resolvedPath = dbPath || process.env.SQLITE_DB_PATH || path.resolve(process.cwd(), 'docupulse.db');
    this.db = new Database(resolvedPath);

    // Performance and integrity pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    // Run repeatable migrations
    runMigrations(this.db);
  }

  public static getInstance(dbPath?: string): DatabaseClient {
    if (!DatabaseClient.instance) {
      DatabaseClient.instance = new DatabaseClient(dbPath);
    }
    return DatabaseClient.instance;
  }

  public static createInMemory(): Database.Database {
    const memDb = new Database(':memory:');
    memDb.pragma('foreign_keys = ON');
    runMigrations(memDb);
    return memDb;
  }

  public getDb(): Database.Database {
    return this.db;
  }

  public close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}

export const dbClient = DatabaseClient.getInstance();
export const db = dbClient.getDb();
