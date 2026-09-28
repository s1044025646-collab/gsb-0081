import { openDb, migrate, makeCtx, Ctx } from "../src/db/connection.js";
import { seedFixtures, seedMenus } from "../fixtures/seed.js";

export function freshCtx(dbPath = ":memory:"): Ctx {
  const db = openDb(dbPath);
  migrate(db);
  let t = Date.parse("2026-09-24T10:00:00Z");
  let seq = 0;
  const ctx = makeCtx(
    db,
    () => new Date((t += 1000)),
    () => `test-key-${++seq}`
  );
  return ctx;
}

export function seededCtx(dbPath = ":memory:") {
  const ctx = freshCtx(dbPath);
  const fx = seedFixtures(ctx)!;
  const menus = seedMenus(ctx)!;
  return { ctx, fx, menus };
}

export function stockOf(ctx: Ctx, ingredientId: number) {
  return ctx.db
    .prepare("SELECT stock_qty, reserved_qty FROM ingredients WHERE id = ?")
    .get(ingredientId) as { stock_qty: number; reserved_qty: number };
}

export function row<T>(ctx: Ctx, sql: string, ...args: (string | number)[]): T {
  return ctx.db.prepare(sql).get(...args) as T;
}
