import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, makeCtx } from "../src/db/connection.js";
import { seedFixtures, seedMenus } from "../fixtures/seed.js";
import { createOrder } from "../src/domain/order.js";
import { startTicket, completeTicket } from "../src/domain/kitchen.js";
import { stockOf } from "./helpers.js";

test("state survives restart; migrations are re-runnable", () => {
  const dir = mkdtempSync(join(tmpdir(), "resto-"));
  const dbFile = join(dir, "test.db");
  try {
    // session 1: seed + order + partial serve
    let db = openDb(dbFile);
    migrate(db);
    let ctx = makeCtx(db);
    const fx = seedFixtures(ctx)!;
    const menus = seedMenus(ctx)!;
    const o = createOrder(ctx, {
      tableId: fx.tables.t2,
      dinerId: fx.diners.d2,
      menuVersionId: menus.v1,
      items: [{ dishId: menus.dishes.kungpao1, qty: 2 }],
    });
    startTicket(ctx, o.ticketIds[0]);
    completeTicket(ctx, o.ticketIds[0], 1, "persist-key-1");
    const chickenAfterS1 = stockOf(ctx, fx.ingredients.chicken);
    db.close();

    // session 2: reopen, re-migrate (no-op), verify persisted state
    db = openDb(dbFile);
    migrate(db);
    migrate(db); // idempotent
    ctx = makeCtx(db);
    const s = stockOf(ctx, fx.ingredients.chicken);
    assert.deepEqual(s, chickenAfterS1);
    const item = db
      .prepare("SELECT status, served_qty FROM order_items WHERE id = ?")
      .get(o.itemIds[0]) as { status: string; served_qty: number };
    assert.equal(item.status, "partially_served");
    assert.equal(item.served_qty, 1);
    // idempotency survives restart: same key does not deduct again
    const dup = completeTicket(ctx, o.ticketIds[0], 1, "persist-key-1");
    assert.equal(dup.duplicated, true);
    assert.deepEqual(stockOf(ctx, fx.ingredients.chicken), chickenAfterS1);
    // finish the rest after restart
    completeTicket(ctx, o.ticketIds[0], 1);
    const done = db
      .prepare("SELECT status FROM tickets WHERE id = ?")
      .get(o.ticketIds[0]) as { status: string };
    assert.equal(done.status, "done");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
