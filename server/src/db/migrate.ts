/**
 * Database connection + migration.
 *
 * Uses the synchronous better-sqlite3 API. `openDatabase` ensures the parent
 * directory of the DB file exists and applies the idempotent schema so a fresh
 * checkout can boot without any manual setup.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { getConfig } from "../config.js";
import { SCHEMA_SQL } from "./schema.js";

export type DB = Database.Database;

/**
 * Apply the schema to an open database. Idempotent.
 */
export function migrate(db: DB): void {
  db.exec(SCHEMA_SQL);
}

/**
 * Open (creating if necessary) the SQLite database at `path`, ensuring the
 * containing directory exists, and run migrations.
 *
 * @param path defaults to the configured DATABASE_PATH. Pass ":memory:" for an
 *             ephemeral database (used by tests).
 */
export function openDatabase(path: string = getConfig().databasePath): DB {
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

// Allow `node --experimental-strip-types src/db/migrate.ts` to run migrations
// directly against the configured database path.
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDatabase();
  // eslint-disable-next-line no-console
  console.log(`Migrated database at ${getConfig().databasePath}`);
  db.close();
}
