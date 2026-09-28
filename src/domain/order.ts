import { Ctx, tx } from "../db/connection.js";
import { ERR, ApiError, badRequest, conflict, notFound } from "./errors.js";
import {
  ModInput,
  checkAllergens,
  effectiveRecipe,
  releaseStock,
  reserveStock,
} from "./recipe.js";

export interface OrderItemInput {
  dishId: number;
  qty: number;
  rush?: boolean;
  mods?: ModInput[];
  dependsOnItemIndex?: number;
}

function logEvent(
  ctx: Ctx,
  orderId: number,
  itemId: number | null,
  type: string,
  payload: unknown
) {
  ctx.db
    .prepare(
      "INSERT INTO order_events (order_id, order_item_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(orderId, itemId, type, JSON.stringify(payload ?? {}), ctx.now());
}

function getOrder(ctx: Ctx, orderId: number) {
  const o = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as
    | Record<string, unknown>
    | undefined;
  if (!o) throw notFound("order");
  return o;
}

function refreshOrderStatus(ctx: Ctx, orderId: number) {
  const items = ctx.db
    .prepare(
      "SELECT qty, served_qty, cancelled_qty, status FROM order_items WHERE order_id = ?"
    )
    .all(orderId) as { qty: number; served_qty: number; cancelled_qty: number; status: string }[];
  const remaining = items.filter((i) => i.status !== "cancelled");
  let status: string;
  if (!remaining.length) status = "cancelled";
  else if (remaining.every((i) => i.status === "served")) status = "served";
  else if (items.some((i) => i.served_qty > 0)) status = "partially_served";
  else status = "open";
  ctx.db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, orderId);
}

function createTicketForItem(
  ctx: Ctx,
  itemId: number,
  qty: number,
  supersedes: number | null,
  dependsOnTicketId: number | null
): number {
  const item = ctx.db
    .prepare(
      `SELECT oi.dish_id, d.station FROM order_items oi JOIN dishes d ON d.id = oi.dish_id
       WHERE oi.id = ?`
    )
    .get(itemId) as { dish_id: number; station: string };
  const st = ctx.db.prepare("SELECT id FROM stations WHERE code = ?").get(item.station) as {
    id: number;
  };
  const r = ctx.db
    .prepare(
      `INSERT INTO tickets (order_item_id, station_id, qty, status, supersedes_ticket_id,
         depends_on_ticket_id, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`
    )
    .run(itemId, st.id, qty, supersedes, dependsOnTicketId, ctx.now());
  return Number(r.lastInsertRowid);
}

export function createOrder(
  ctx: Ctx,
  input: {
    tableId: number;
    dinerId: number;
    menuVersionId: number;
    items: OrderItemInput[];
    idempotencyKey?: string;
  }
  ) {
  return tx(ctx, () => {
    for (const f of ["tableId", "dinerId", "menuVersionId"] as const)
      if (!Number.isInteger(input?.[f])) throw badRequest(`${f} must be an integer`);
    if (input.idempotencyKey) {
      const dup = ctx.db
        .prepare("SELECT id FROM orders WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as { id: number } | undefined;
      if (dup)
        return { orderId: dup.id, itemIds: [] as number[], ticketIds: [] as number[], duplicated: true };
    }
    const mv = ctx.db
      .prepare("SELECT status FROM menu_versions WHERE id = ?")
      .get(input.menuVersionId) as { status: string } | undefined;
    if (!mv) throw notFound("menu version");
    if (mv.status !== "active")
      throw conflict(ERR.MENU_NOT_ACTIVE, "menu version is not active");
    if (!input.items?.length) throw badRequest("items required");

    // Validate everything before writing: allergens + stock per item.
    const prepared = input.items.map((it, idx) => {
      if (!Number.isInteger(it.qty) || it.qty <= 0) throw badRequest(`items[${idx}].qty invalid`);
      const dish = ctx.db
        .prepare("SELECT id, menu_version_id FROM dishes WHERE id = ?")
        .get(it.dishId) as { id: number; menu_version_id: number } | undefined;
      if (!dish) throw badRequest(`unknown dish ${it.dishId}`);
      if (dish.menu_version_id !== input.menuVersionId)
        throw badRequest(`dish ${it.dishId} not in menu version ${input.menuVersionId}`);
      const mods = it.mods ?? [];
      const lines = effectiveRecipe(ctx, it.dishId, mods);
      checkAllergens(ctx, input.dinerId, lines);
      return { it, mods, lines };
    });
    // Stock check across the whole order (aggregate demand).
    const demand = new Map<number, { name: string; qty: number }>();
    for (const p of prepared)
      for (const l of p.lines) {
        const d = demand.get(l.ingredientId) ?? { name: l.ingredientName, qty: 0 };
        d.qty += l.qty * p.it.qty;
        demand.set(l.ingredientId, d);
      }
    const shortages: unknown[] = [];
    for (const [id, d] of demand) {
      const row = ctx.db
        .prepare("SELECT stock_qty, reserved_qty FROM ingredients WHERE id = ?")
        .get(id) as { stock_qty: number; reserved_qty: number };
      if (row.stock_qty - row.reserved_qty < d.qty - 1e-9)
        shortages.push({
          ingredient: d.name,
          need: d.qty,
          available: row.stock_qty - row.reserved_qty,
        });
    }
    if (shortages.length)
      throw conflict(ERR.INSUFFICIENT_STOCK, "insufficient stock", { shortages });

    const r = ctx.db
      .prepare(
        `INSERT INTO orders (table_id, diner_id, menu_version_id, status, idempotency_key, created_at)
         VALUES (?, ?, ?, 'open', ?, ?)`
      )
      .run(input.tableId, input.dinerId, input.menuVersionId, input.idempotencyKey ?? null, ctx.now());
    const orderId = Number(r.lastInsertRowid);

    const ticketIds: number[] = [];
    const itemIds: number[] = [];
    for (const p of prepared) {
      const ir = ctx.db
        .prepare(
          "INSERT INTO order_items (order_id, dish_id, qty, rush, status) VALUES (?, ?, ?, ?, 'pending')"
        )
        .run(orderId, p.it.dishId, p.it.qty, p.it.rush ? 1 : 0);
      const itemId = Number(ir.lastInsertRowid);
      itemIds.push(itemId);
      const modIns = ctx.db.prepare(
        `INSERT INTO order_item_mods (order_item_id, kind, ingredient_id, replaces_ingredient_id, qty)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const m of p.mods)
        modIns.run(itemId, m.kind, m.ingredientId, m.replacesIngredientId ?? null, m.qty ?? 0);
      reserveStock(ctx, p.lines, p.it.qty);
      const depTicket =
        p.it.dependsOnItemIndex !== undefined
          ? ticketIds[p.it.dependsOnItemIndex] ??
            (() => {
              throw badRequest(`invalid dependsOnItemIndex ${p.it.dependsOnItemIndex}`);
            })()
          : null;
      ticketIds.push(createTicketForItem(ctx, itemId, p.it.qty, null, depTicket));
      logEvent(ctx, orderId, itemId, "item_added", { qty: p.it.qty, mods: p.mods });
    }
    logEvent(ctx, orderId, null, "order_created", { items: itemIds });
    return { orderId, itemIds, ticketIds, duplicated: false };
  });
}

function itemMods(ctx: Ctx, itemId: number): ModInput[] {
  const rows = ctx.db
    .prepare(
      "SELECT kind, ingredient_id, replaces_ingredient_id, qty FROM order_item_mods WHERE order_item_id = ?"
    )
    .all(itemId) as {
    kind: ModInput["kind"];
    ingredient_id: number;
    replaces_ingredient_id: number | null;
    qty: number;
  }[];
  return rows.map((r) => ({
    kind: r.kind,
    ingredientId: r.ingredient_id,
    replacesIngredientId: r.replaces_ingredient_id ?? undefined,
    qty: r.qty,
  }));
}

/** Modify an item's mods. If production already started, the old ticket is
 *  voided and a superseding ticket is created — the original is never overwritten. */
export function modifyItem(ctx: Ctx, itemId: number, addMods: ModInput[]) {
  return tx(ctx, () => {
    const item = ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(itemId) as
      | Record<string, number>
      | undefined;
    if (!item) throw notFound("order item");
    if (["served", "cancelled"].includes(String(item.status)))
      throw conflict(ERR.INVALID_STATE, `cannot modify item in status ${item.status}`);
    const order = getOrder(ctx, Number(item.order_id));
    const remaining = Number(item.qty) - Number(item.served_qty) - Number(item.cancelled_qty);
    if (remaining <= 0) throw conflict(ERR.INVALID_STATE, "nothing left to modify");

    const oldMods = itemMods(ctx, itemId);
    const oldLines = effectiveRecipe(ctx, Number(item.dish_id), oldMods);
    const newMods = [...oldMods, ...addMods];
    const newLines = effectiveRecipe(ctx, Number(item.dish_id), newMods);
    // Re-validate against the diner's allergies — substitution cannot bypass checks.
    checkAllergens(ctx, Number(order.diner_id), newLines);

    // Rebalance reservation for the remaining quantity.
    releaseStock(ctx, oldLines, remaining);
    reserveStock(ctx, newLines, remaining);

    const modIns = ctx.db.prepare(
      `INSERT INTO order_item_mods (order_item_id, kind, ingredient_id, replaces_ingredient_id, qty)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const m of addMods)
      modIns.run(itemId, m.kind, m.ingredientId, m.replacesIngredientId ?? null, m.qty ?? 0);

    // Void active ticket and supersede.
    const active = ctx.db
      .prepare(
        "SELECT id FROM tickets WHERE order_item_id = ? AND status IN ('queued','in_progress')"
      )
      .get(itemId) as { id: number } | undefined;
    let newTicketId: number | null = null;
    if (active) {
      ctx.db.prepare("UPDATE tickets SET status = 'voided' WHERE id = ?").run(active.id);
      ctx.db
        .prepare("INSERT INTO ticket_events (ticket_id, event_type, qty, created_at) VALUES (?, 'voided', 0, ?)")
        .run(active.id, ctx.now());
      newTicketId = createTicketForItem(ctx, itemId, remaining, active.id, null);
    }
    if (String(item.status) === "pending")
      ctx.db.prepare("UPDATE order_items SET status = 'pending' WHERE id = ?").run(itemId);
    logEvent(ctx, Number(item.order_id), itemId, "item_modified", {
      addedMods: addMods,
      voidedTicket: active?.id ?? null,
      newTicket: newTicketId,
    });
    return { itemId, voidedTicket: active?.id ?? null, newTicket: newTicketId };
  });
}

/** Cancel qty servings of an item; releases reserved stock for the unserved part. */
export function cancelItem(ctx: Ctx, itemId: number, qty: number) {
  return tx(ctx, () => {
    const item = ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(itemId) as
      | Record<string, number>
      | undefined;
    if (!item) throw notFound("order item");
    const remaining = Number(item.qty) - Number(item.served_qty) - Number(item.cancelled_qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > remaining)
      throw badRequest(`qty must be 1..${remaining}`);
    const lines = effectiveRecipe(ctx, Number(item.dish_id), itemMods(ctx, itemId));
    releaseStock(ctx, lines, qty);
    const newCancelled = Number(item.cancelled_qty) + qty;
    const newStatus =
      newCancelled + Number(item.served_qty) === Number(item.qty)
        ? Number(item.served_qty) > 0
          ? "served"
          : "cancelled"
        : item.status;
    ctx.db
      .prepare("UPDATE order_items SET cancelled_qty = ?, status = ? WHERE id = ?")
      .run(newCancelled, newStatus, itemId);
    // Shrink or void the active ticket to match remaining work.
    const active = ctx.db
      .prepare(
        "SELECT id, qty, done_qty FROM tickets WHERE order_item_id = ? AND status IN ('queued','in_progress')"
      )
      .get(itemId) as { id: number; qty: number; done_qty: number } | undefined;
    if (active) {
      const newTicketQty = active.qty - qty;
      if (newTicketQty <= active.done_qty) {
        ctx.db.prepare("UPDATE tickets SET status = 'voided' WHERE id = ?").run(active.id);
        ctx.db
          .prepare("INSERT INTO ticket_events (ticket_id, event_type, qty, created_at) VALUES (?, 'voided', 0, ?)")
          .run(active.id, ctx.now());
      } else {
        ctx.db.prepare("UPDATE tickets SET qty = ? WHERE id = ?").run(newTicketQty, active.id);
      }
    }
    logEvent(ctx, Number(item.order_id), itemId, "item_cancelled", { qty });
    refreshOrderStatus(ctx, Number(item.order_id));
    return { itemId, cancelled: qty };
  });
}

export function setRush(ctx: Ctx, itemId: number, rush: boolean) {
  return tx(ctx, () => {
    const r = ctx.db
      .prepare("UPDATE order_items SET rush = ? WHERE id = ? AND status NOT IN ('served','cancelled')")
      .run(rush ? 1 : 0, itemId);
    if (r.changes !== 1) throw conflict(ERR.INVALID_STATE, "item not modifiable");
    const item = ctx.db.prepare("SELECT order_id FROM order_items WHERE id = ?").get(itemId) as {
      order_id: number;
    };
    logEvent(ctx, item.order_id, itemId, rush ? "rush_set" : "rush_cleared", {});
    return { itemId, rush };
  });
}

export function getOrderView(ctx: Ctx, orderId: number) {
  const order = getOrder(ctx, orderId);
  const items = ctx.db
    .prepare(
      `SELECT oi.*, d.name AS dish_name FROM order_items oi JOIN dishes d ON d.id = oi.dish_id
       WHERE oi.order_id = ? ORDER BY oi.id`
    )
    .all(orderId);
  const events = ctx.db
    .prepare("SELECT * FROM order_events WHERE order_id = ? ORDER BY id")
    .all(orderId);
  return { order, items, events };
}

export function listOrders(ctx: Ctx, limit: number, offset: number, status?: string) {
  if (status)
    return ctx.db
      .prepare("SELECT * FROM orders WHERE status = ? ORDER BY id LIMIT ? OFFSET ?")
      .all(status, limit, offset);
  return ctx.db.prepare("SELECT * FROM orders ORDER BY id LIMIT ? OFFSET ?").all(limit, offset);
}
