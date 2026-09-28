import { Ctx } from "../db/connection.js";
import { ERR, ApiError, badRequest, notFound, requireFields } from "./errors.js";

export function createMenuVersion(ctx: Ctx, name: string) {
  if (!name) throw badRequest("name required");
  const r = ctx.db
    .prepare("INSERT INTO menu_versions (name, status, created_at) VALUES (?, 'draft', ?)")
    .run(name, ctx.now());
  return { id: Number(r.lastInsertRowid), name, status: "draft" };
}

export function addDish(
  ctx: Ctx,
  menuVersionId: number,
  dish: { name: string; station: string; priceCents?: number; recipe: { ingredient: string; qty: number }[] }
) {
  requireFields(dish as unknown as Record<string, unknown>, ["name", "station", "recipe"]);
  const mv = ctx.db.prepare("SELECT status FROM menu_versions WHERE id = ?").get(menuVersionId) as
    | { status: string }
    | undefined;
  if (!mv) throw notFound("menu version");
  if (mv.status !== "draft") throw new ApiError(409, ERR.INVALID_STATE, "menu version not editable");
  const st = ctx.db.prepare("SELECT id FROM stations WHERE code = ?").get(dish.station) as
    | { id: number }
    | undefined;
  if (!st) throw badRequest(`unknown station ${dish.station}`);
  const r = ctx.db
    .prepare(
      "INSERT INTO dishes (menu_version_id, name, station, price_cents) VALUES (?, ?, ?, ?)"
    )
    .run(menuVersionId, dish.name, dish.station, dish.priceCents ?? 0);
  const dishId = Number(r.lastInsertRowid);
  const ins = ctx.db.prepare(
    "INSERT INTO recipes (dish_id, ingredient_id, qty) VALUES (?, ?, ?)"
  );
  for (const line of dish.recipe) {
    const ing = ctx.db.prepare("SELECT id FROM ingredients WHERE name = ?").get(line.ingredient) as
      | { id: number }
      | undefined;
    if (!ing) throw badRequest(`unknown ingredient ${line.ingredient}`);
    if (!(line.qty > 0)) throw badRequest("recipe qty must be positive");
    ins.run(dishId, ing.id, line.qty);
  }
  return { id: dishId, name: dish.name };
}

export function activateMenu(ctx: Ctx, menuVersionId: number) {
  const mv = ctx.db.prepare("SELECT id FROM menu_versions WHERE id = ?").get(menuVersionId);
  if (!mv) throw notFound("menu version");
  ctx.db.prepare("UPDATE menu_versions SET status = 'archived' WHERE status = 'active'").run();
  ctx.db.prepare("UPDATE menu_versions SET status = 'active' WHERE id = ?").run(menuVersionId);
  return { id: menuVersionId, status: "active" };
}

export function listMenus(ctx: Ctx, limit: number, offset: number) {
  return ctx.db
    .prepare("SELECT * FROM menu_versions ORDER BY id LIMIT ? OFFSET ?")
    .all(limit, offset);
}
