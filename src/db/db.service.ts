import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';

const DEFAULT_DB_PATH = ':memory:';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private _db: Database.Database | null = null;

  onModuleInit() {
    const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
    this.logger.log(`Opening SQLite at ${dbPath}`);
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this._db.pragma('synchronous = NORMAL');
    runMigrations(this._db);
  }

  onModuleDestroy() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  get db(): Database.Database {
    if (!this._db) {
      throw new Error('DbService used before init');
    }
    return this._db;
  }

  /**
   * Execute `fn` inside an IMMEDIATE transaction. SQLite IMMEDIATE acquires a
   * RESERVED lock right away, which together with WAL gives us serializable
   * semantics for the critical balance-mutation paths.
   */
  transaction<T>(fn: (db: Database.Database) => T): T {
    const tx = this.db.transaction(fn);
    return tx.immediate(this.db);
  }

  /** For tests only: reset the schema. */
  resetForTests() {
    if (!this._db) throw new Error('not initialised');
    runMigrations(this._db, { reset: true });
  }
}
