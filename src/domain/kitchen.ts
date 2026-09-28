import { Ctx, tx } from "../db/connection.js";
import { ERR, badRequest, conflict, notFound } from "./errors.js";
import { consumeStock, effectiveRecipe, restock } from "./recipe.js";

function getTicket(ctx: Ctx, ticketId: number) {
  const t = ctx.db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId) as
    | Record<string, number | string | null>
    | undefined;
  if (!t) throw notFound("ticket");
  return t;
}

function itemLines(ctx: Ctx, itemId: number) {
  const item = ctx.db
    .prepare("SELECT dish_id FROM order_items WHERE id = ?")
    .get(itemId) as { dish_id: number };
  const mods = ctx.db
    .prepare(
      "SELECT kind, ingredient_id, replaces_ingredient_id, qty FROM order_item_mods WHERE order_item_id = ?"
    )
    .all(itemId) as {
    kind: "add" | "remove" | "substitute";
    ingredient_id: number;
    replaces_ingredient_id: number | null;
    qty: number;
  }[];
  return effectiveRecipe(
    ctx,
    item.dish_id,
    mods.map((m) => ({
      kind: m.kind,
      ingredientId: m.ingredient_id,
      replacesIngredientId: m.replaces_ingredient_id ?? undefined,
      qty: m.qty,
    }))
  );
}

function ticketEvent(ctx: Ctx, ticketId: number, type: string, qty: number) {
  ctx.db
    .prepare("INSERT INTO ticket_events (ticket_id, event_type, qty, created_at) VALUES (?, ?, ?, ?)")
    .run(ticketId, type, qty, ctx.now());
}

export function startTicket(ctx: Ctx, ticketId: number) {
  return tx(ctx, () => {
    const t = getTicket(ctx, ticketId);
    if (t.status !== "queued")
      throw conflict(ERR.INVALID_STATE, `ticket ${ticketId} is ${t.status}, not queued`);
    if (t.depends_on_ticket_id) {
      // Follow the supersede chain: a voided ticket's replacement carries the dependency.
      let dep = getTicket(ctx, Number(t.depends_on_ticket_id));
      for (;;) {
        const next = ctx.db
          .prepare(
            "SELECT * FROM tickets WHERE supersedes_ticket_id = ? AND status != 'voided' ORDER BY id DESC LIMIT 1"
          )
          .get(Number(dep.id)) as Record<string, number | string | null> | undefined;
        if (!next) break;
        dep = next;
      }
      if (dep.status !== "done")
        throw conflict(ERR.DEPENDENCY_NOT_MET, `depends on ticket ${dep.id} (${dep.status})`);
    }
    const r = ctx.db
      .prepare("UPDATE tickets SET status = 'in_progress' WHERE id = ? AND status = 'queued'")
      .run(ticketId);
    if (r.changes !== 1) throw conflict(ERR.INVALID_STATE, "ticket state changed concurrently");
    ticketEvent(ctx, ticketId, "started", 0);
    return { ticketId, status: "in_progress" };
  });
}

/** Complete (serve) qty servings of a ticket. Idempotent via idempotencyKey:
 *  a repeated key returns the original batch and never deducts stock twice. */
export function completeTicket(ctx: Ctx, ticketId: number, qty: number, idempotencyKey?: string) {
  return tx(ctx, () => {
    if (idempotencyKey) {
      const dup = ctx.db
        .prepare("SELECT id, qty FROM serve_batches WHERE idempotency_key = ?")
        .get(idempotencyKey) as { id: number; qty: number } | undefined;
      if (dup) return { batchId: dup.id, qty: dup.qty, duplicated: true };
    }
    const t = getTicket(ctx, ticketId);
    if (t.status !== "in_progress")
      throw conflict(ERR.INVALID_STATE, `ticket ${ticketId} is ${t.status}, not in_progress`);
    const remaining = Number(t.qty) - Number(t.done_qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > remaining)
      throw badRequest(`qty must be 1..${remaining}`);

    const itemId = Number(t.order_item_id);
    const lines = itemLines(ctx, itemId);
    consumeStock(ctx, lines, qty);

    const newDone = Number(t.done_qty) + qty;
    const done = newDone === Number(t.qty);
    ctx.db
      .prepare("UPDATE tickets SET done_qty = ?, status = ? WHERE id = ?")
      .run(newDone, done ? "done" : "in_progress", ticketId);
    ticketEvent(ctx, ticketId, done ? "completed" : "partial", qty);

    const br = ctx.db
      .prepare(
        `INSERT INTO serve_batches (order_item_id, ticket_id, qty, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(itemId, ticketId, qty, idempotencyKey ?? null, ctx.now());

    const item = ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(itemId) as Record<
      string,
      number
    >;
    const newServed = Number(item.served_qty) + qty;
    const itemDone = newServed + Number(item.cancelled_qty) === Number(item.qty);
    ctx.db
      .prepare("UPDATE order_items SET served_qty = ?, status = ? WHERE id = ?")
      .run(newServed, itemDone ? "served" : "partially_served", itemId);
    ctx.db
      .prepare(
        "INSERT INTO order_events (order_id, order_item_id, event_type, payload, created_at) VALUES (?, ?, 'item_served', ?, ?)"
      )
      .run(item.order_id, itemId, JSON.stringify({ qty, ticketId }), ctx.now());
    // Refresh order status.
    const items = ctx.db
      .prepare("SELECT status, served_qty FROM order_items WHERE order_id = ?")
      .all(item.order_id) as { status: string; served_qty: number }[];
    const live = items.filter((i) => i.status !== "cancelled");
    const oStatus = live.every((i) => i.status === "served")
      ? "served"
      : items.some((i) => i.served_qty > 0)
        ? "partially_served"
        : "open";
    ctx.db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(oStatus, item.order_id);
    return { batchId: Number(br.lastInsertRowid), qty, duplicated: false };
  });
}

/** Redo qty servings of a finished ticket: consumes fresh stock, creates a
 *  superseding ticket marked redo. */
export function redoTicket(ctx: Ctx, ticketId: number, qty: number) {
  return tx(ctx, () => {
    const t = getTicket(ctx, ticketId);
    if (t.status !== "done")
      throw conflict(ERR.INVALID_STATE, "only done tickets can be redone");
    if (!Number.isInteger(qty) || qty <= 0 || qty > Number(t.done_qty))
      throw badRequest(`qty must be 1..${t.done_qty}`);
    const itemId = Number(t.order_item_id);
    const lines = itemLines(ctx, itemId);
    // Fresh stock: reserve then consume immediately for the redo.
    const upd = ctx.db.prepare(
      "UPDATE ingredients SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?"
    );
    const mv = ctx.db.prepare(
      `INSERT INTO inventory_moves (ingredient_id, delta_stock, delta_reserved, reason, ref_type, ref_id, created_at)
       VALUES (?, ?, 0, 'redo_consume', 'ticket', ?, ?)`
    );
    for (const l of lines) {
      const q = l.qty * qty;
      const r = upd.run(q, l.ingredientId, q);
      if (r.changes !== 1)
        throw conflict(ERR.INSUFFICIENT_STOCK, `insufficient stock for redo: ${l.ingredientName}`);
      mv.run(l.ingredientId, -q, ticketId, ctx.now());
    }
    const r2 = ctx.db
      .prepare(
        `INSERT INTO tickets (order_item_id, station_id, qty, done_qty, status, supersedes_ticket_id, created_at)
         VALUES (?, ?, ?, ?, 'done', ?, ?)`
      )
      .run(itemId, t.station_id, qty, qty, ticketId, ctx.now());
    ticketEvent(ctx, Number(r2.lastInsertRowid), "redo", qty);
    return { redoTicketId: Number(r2.lastInsertRowid), qty };
  });
}

/** Return qty servings of a served item with a reason; optional restock. */
export function returnItem(ctx: Ctx, itemId: number, qty: number, reason: string, doRestock: boolean) {
  return tx(ctx, () => {
    if (!reason) throw badRequest("reason required");
    const item = ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(itemId) as
      | Record<string, number>
      | undefined;
    if (!item) throw notFound("order item");
    if (!Number.isInteger(qty) || qty <= 0 || qty > Number(item.served_qty))
      throw badRequest(`qty must be 1..${item.served_qty}`);
    ctx.db
      .prepare(
        "INSERT INTO return_reasons (order_item_id, qty, reason, restock, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(itemId, qty, reason, doRestock ? 1 : 0, ctx.now());
    if (doRestock) restock(ctx, itemLines(ctx, itemId), qty);
    ctx.db
      .prepare("UPDATE order_items SET served_qty = served_qty - ? WHERE id = ?")
      .run(qty, itemId);
    ctx.db
      .prepare(
        "INSERT INTO order_events (order_id, order_item_id, event_type, payload, created_at) VALUES (?, ?, 'item_returned', ?, ?)"
      )
      .run(item.order_id, itemId, JSON.stringify({ qty, reason, restock: doRestock }), ctx.now());
    return { itemId, returned: qty, restocked: doRestock };
  });
}

/** Station queue: rush first, then FIFO. */
export function stationQueue(ctx: Ctx, stationCode: string, limit: number, offset: number) {
  const st = ctx.db.prepare("SELECT id FROM stations WHERE code = ?").get(stationCode) as
    | { id: number }
    | undefined;
  if (!st) throw notFound("station");
  return ctx.db
    .prepare(
      `SELECT t.id AS ticket_id, t.status, t.qty, t.done_qty, t.created_at,
              oi.rush, d.name AS dish_name, o.table_id
       FROM tickets t
       JOIN order_items oi ON oi.id = t.order_item_id
       JOIN dishes d ON d.id = oi.dish_id
       JOIN orders o ON o.id = oi.order_id
       WHERE t.station_id = ? AND t.status IN ('queued','in_progress')
       ORDER BY oi.rush DESC, t.created_at ASC, t.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(st.id, limit, offset);
}
