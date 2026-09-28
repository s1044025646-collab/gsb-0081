import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.js";

export type Clock = () => Date;
export type IdGen = () => string;

export interface Ctx {
  db: DatabaseSync;
  now: () => string;
  newKey: IdGen;
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const applied = new Set(
    (db.prepare("SELECT id FROM migrations").all() as { id: string }[]).map((r) => r.id)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(
        m.id,
        new Date().toISOString()
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

let seq = 0;
export function makeCtx(db: DatabaseSync, clock?: Clock, idGen?: IdGen): Ctx {
  return {
    db,
    now: () => (clock ? clock() : new Date()).toISOString(),
    newKey: idGen ?? (() => `k${Date.now().toString(36)}-${(seq++).toString(36)}`),
  };
}

/** Run fn inside IMMEDIATE transaction; rolls back on throw or process-level error. */
export function tx<T>(ctx: Ctx, fn: () => T): T {
  ctx.db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    ctx.db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      ctx.db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}
