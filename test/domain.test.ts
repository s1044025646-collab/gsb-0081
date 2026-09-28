import { test } from "node:test";
import assert from "node:assert/strict";
import { seededCtx, stockOf, row } from "./helpers.js";
import { createOrder, modifyItem, cancelItem, setRush } from "../src/domain/order.js";
import {
  startTicket,
  completeTicket,
  redoTicket,
  returnItem,
  stationQueue,
} from "../src/domain/kitchen.js";
import { ApiError } from "../src/domain/errors.js";

test("allergen conflict blocks order with concrete sources", () => {
  const { ctx, fx, menus } = seededCtx();
  assert.throws(
    () =>
      createOrder(ctx, {
        tableId: fx.tables.t1,
        dinerId: fx.diners.d1, // peanut allergy
        menuVersionId: menus.v1,
        items: [{ dishId: menus.dishes.kungpao1, qty: 1 }],
      }),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.code, "ALLERGEN_CONFLICT");
      const details = e.details as { conflicts: { allergen: string; ingredient: string }[] };
      assert.equal(details.conflicts[0].allergen, "peanut");
      assert.equal(details.conflicts[0].ingredient, "花生酱");
      return true;
    }
  );
  // nothing persisted
  assert.equal(row<{ c: number }>(ctx, "SELECT COUNT(*) c FROM orders").c, 0);
});

test("substitution cannot bypass allergen check", () => {
  const { ctx, fx, menus } = seededCtx();
  // d3 is soy-allergic; substitute scallion -> tofu (soy) must be blocked
  assert.throws(
    () =>
      createOrder(ctx, {
        tableId: fx.tables.t3,
        dinerId: fx.diners.d3,
        menuVersionId: menus.v1,
        items: [
          {
            dishId: menus.dishes.salad,
            qty: 1,
            mods: [
              { kind: "substitute", ingredientId: fx.ingredients.tofu, replacesIngredientId: fx.ingredients.scallion },
            ],
          },
        ],
      }),
    /allergen conflict/i
  );
  // but substituting tofu -> scallion (removing soy) passes for soy-allergic diner
  const ok = createOrder(ctx, {
    tableId: fx.tables.t3,
    dinerId: fx.diners.d3,
    menuVersionId: menus.v1,
    items: [
      {
        dishId: menus.dishes.salad,
        qty: 1,
        mods: [
          { kind: "remove", ingredientId: fx.ingredients.tofu },
          { kind: "add", ingredientId: fx.ingredients.scallion, qty: 10 },
        ],
      },
    ],
  });
  assert.ok(ok.orderId);
});

test("inventory conservation across reserve/consume/release", () => {
  const { ctx, fx, menus } = seededCtx();
  const chicken = fx.ingredients.chicken;
  const before = stockOf(ctx, chicken);
  const o = createOrder(ctx, {
    tableId: fx.tables.t2,
    dinerId: fx.diners.d2,
    menuVersionId: menus.v1,
    items: [{ dishId: menus.dishes.kungpao1, qty: 3 }],
  });
  let s = stockOf(ctx, chicken);
  assert.equal(s.reserved_qty, before.reserved_qty + 600); // 200g x3
  assert.equal(s.stock_qty, before.stock_qty);
  // serve 1, cancel 1, 1 remains
  startTicket(ctx, o.ticketIds[0]);
  completeTicket(ctx, o.ticketIds[0], 1);
  cancelItem(ctx, o.itemIds[0], 1);
  s = stockOf(ctx, chicken);
  assert.equal(s.stock_qty, before.stock_qty - 200);
  assert.equal(s.reserved_qty, before.reserved_qty + 200);
  // ledger cross-check: sum of moves equals net change
  const moves = row<{ ds: number; dr: number }>(
    ctx,
    "SELECT COALESCE(SUM(delta_stock),0) ds, COALESCE(SUM(delta_reserved),0) dr FROM inventory_moves WHERE ingredient_id = ?",
    chicken
  );
  assert.equal(moves.ds, s.stock_qty - before.stock_qty);
  assert.equal(moves.dr, s.reserved_qty - before.reserved_qty);
});

test("modifying an in-progress item voids and supersedes its ticket", () => {
  const { ctx, fx, menus } = seededCtx();
  const o = createOrder(ctx, {
    tableId: fx.tables.t2,
    dinerId: fx.diners.d2,
    menuVersionId: menus.v1,
    items: [{ dishId: menus.dishes.kungpao1, qty: 1 }],
  });
  startTicket(ctx, o.ticketIds[0]);
  const r = modifyItem(ctx, o.itemIds[0], [
    { kind: "add", ingredientId: fx.ingredients.scallion, qty: 5 },
  ]);
  assert.equal(r.voidedTicket, o.ticketIds[0]);
  assert.ok(r.newTicket);
  const old = row<{ status: string; qty: number }>(
    ctx,
    "SELECT status, qty FROM tickets WHERE id = ?",
    o.ticketIds[0]
  );
  assert.equal(old.status, "voided"); // original preserved, not overwritten
  assert.equal(old.qty, 1);
  const nt = row<{ status: string; supersedes_ticket_id: number }>(
    ctx,
    "SELECT status, supersedes_ticket_id FROM tickets WHERE id = ?",
    r.newTicket!
  );
  assert.equal(nt.status, "queued");
  assert.equal(nt.supersedes_ticket_id, o.ticketIds[0]);
});

test("idempotent complete never deducts stock twice", () => {
  const { ctx, fx, menus } = seededCtx();
  const o = createOrder(ctx, {
    tableId: fx.tables.t2,
    dinerId: fx.diners.d2,
    menuVersionId: menus.v1,
    items: [{ dishId: menus.dishes.kungpao1, qty: 1 }],
  });
  startTicket(ctx, o.ticketIds[0]);
  const before = stockOf(ctx, fx.ingredients.chicken);
  const r1 = completeTicket(ctx, o.ticketIds[0], 1, "serve-abc");
  const r2 = completeTicket(ctx, o.ticketIds[0], 1, "serve-abc");
  assert.equal(r2.duplicated, true);
  assert.equal(r1.batchId, r2.batchId);
  const after = stockOf(ctx, fx.ingredients.chicken);
  assert.equal(after.stock_qty, before.stock_qty - 200);
  assert.equal(
    row<{ c: number }>(ctx, "SELECT COUNT(*) c FROM serve_batches WHERE idempotency_key = 'serve-abc'").c,
    1
  );
});

test("idempotent order creation returns same order", () => {
  const { ctx, fx, menus } = seededCtx();
  const input = {
    tableId: fx.tables.t2,
    dinerId: fx.diners.d2,
    menuVersionId: menus.v1,
    items: [{ dishId: menus.dishes.kungpao1, qty: 1 }],
    idempotencyKey: "order-xyz",
  };
  const a = createOrder(ctx, input);
  const b = createOrder(ctx, input);
  assert.equal(a.orderId, b.orderId);
  assert.equal(b.duplicated, true);
  assert.equal(row<{ c: number }>(ctx, "SELECT COUNT(*) c FROM orders").c, 1);
});

test("dependency: dependent ticket cannot start before prerequisite is done", () => {
  const { ctx, fx, menus } = seededCtx();
  const o = createOrder(ctx, {
    tableId: fx.tables.t2,
    dinerId: fx.diners.d2,
    menuVersionId: menus.v1,
    items: [
      { dishId: menus.dishes.kungpao1, qty: 1 },
      { dishId: menus.dishes.riceDish, qty: 1, dependsOnItemIndex: 0 },
    ],
  });
  assert.throws(() => startTicket(ctx, o.ticketIds[1]), /depends on ticket/);
  startTicket(ctx, o.ticketIds[0]);
  completeTicket(ctx, o.ticketIds[0], 1);
  const r = startTicket(ctx, o.ticketIds[1]);
  assert.equal(r.status, "in_progress");
});

test("rush orders jump the station queue", () => {
  const { ctx, fx, menus } = seededCtx();
  const mk = () =>
    createOrder(ctx, {
      tableId: fx.tables.t2,
      dinerId: fx.diners.d2,
      menuVersionId: menus.v1,
      items: [{ dishId: menus.dishes.kungpao1, qty: 1 }],
    });
  const a = mk();
  const b = mk();
  setRush(ctx, b.itemIds[0], true);
  const q = stationQueue(ctx, "hot", 10, 0) as { ticket_id: number }[];
  assert.equal(q[0].ticket_id, b.ticketIds[0]);
  assert.equal(q[1].ticket_id, a.ticketIds[0]);
});

test("partial serve, return with restock, and redo accounting", () => {
  const { ctx, fx, menus } = seededCtx();
  const tofu = fx.ingredients.tofu;
  const before = stockOf(ctx, tofu);
  const o = createOrder(ctx, {
    tableId: fx.tables.t2,
    dinerId: fx.diners.d2,
    menuVersionId: menus.v1,
    items: [{ dishId: menus.dishes.salad, qty: 2 }],
  });
  startTicket(ctx, o.ticketIds[0]);
  completeTicket(ctx, o.ticketIds[0], 1); // partial
  let item = row<{ status: string; served_qty: number }>(
    ctx,
    "SELECT status, served_qty FROM order_items WHERE id = ?",
    o.itemIds[0]
  );
  assert.equal(item.status, "partially_served");
  // return the served one with restock
  returnItem(ctx, o.itemIds[0], 1, "太咸", true);
  let s = stockOf(ctx, tofu);
  assert.equal(s.stock_qty, before.stock_qty); // consumed 150, restocked 150
  // finish remaining; item stays partially_served because 1 serving was returned
  completeTicket(ctx, o.ticketIds[0], 1);
  const item2 = row<{ status: string; served_qty: number }>(
    ctx,
    "SELECT status, served_qty FROM order_items WHERE id = ?",
    o.itemIds[0]
  );
  assert.equal(item2.status, "partially_served");
  assert.equal(item2.served_qty, 1);
  // redo 1 serving of the done ticket consumes fresh stock
  const redo = redoTicket(ctx, o.ticketIds[0], 1);
  assert.ok(redo.redoTicketId);
  s = stockOf(ctx, tofu);
  assert.equal(s.stock_qty, before.stock_qty - 300); // 2 served + 1 redo - 1 restocked
});

test("insufficient stock blocks order and concurrent orders cannot oversell", async () => {
  const { ctx, fx, menus } = seededCtx();
  const shrimp = fx.ingredients.shrimp; // 1500g, 120g per salad -> 12 max
  ctx.db.prepare("UPDATE menu_versions SET status = 'active' WHERE id = ?").run(menus.v2);
  // direct: order more than stock
  assert.throws(
    () =>
      createOrder(ctx, {
        tableId: fx.tables.t2,
        dinerId: fx.diners.d2,
        menuVersionId: menus.v2,
        items: [{ dishId: menus.dishes.shrimpSalad, qty: 13 }],
      }),
    (e: unknown) => (e as ApiError).code === "INSUFFICIENT_STOCK"
  );
  // concurrent: 20 parallel orders of 1 salad each; at most 12 succeed
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      Promise.resolve().then(() =>
        createOrder(ctx, {
          tableId: fx.tables.t2,
          dinerId: fx.diners.d2,
          menuVersionId: menus.v2,
          items: [{ dishId: menus.dishes.shrimpSalad, qty: 1 }],
        })
      ).then(
        () => "ok",
        (e) => ((e as ApiError).code === "INSUFFICIENT_STOCK" ? "rejected" : Promise.reject(e))
      )
    )
  );
  const okCount = results.filter((r) => r === "ok").length;
  assert.equal(okCount, 12);
  const s = stockOf(ctx, shrimp);
  assert.ok(s.reserved_qty <= s.stock_qty);
  assert.equal(s.reserved_qty, 1440); // 12 x 120g
});
