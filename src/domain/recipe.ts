import { Ctx } from "../db/connection.js";
import { ApiError, ERR, conflict } from "./errors.js";

export interface ModInput {
  kind: "add" | "remove" | "substitute";
  ingredientId: number;
  replacesIngredientId?: number;
  qty?: number;
}

export interface EffectiveLine {
  ingredientId: number;
  ingredientName: string;
  qty: number;
  source: "recipe" | "add" | "substitute";
}

/** Compute effective ingredient lines for a dish plus mods. Substitution never
 *  skips allergen checks — callers must re-validate the effective lines. */
export function effectiveRecipe(ctx: Ctx, dishId: number, mods: ModInput[]): EffectiveLine[] {
  const base = ctx.db
    .prepare(
      `SELECT r.ingredient_id AS ingredientId, i.name AS ingredientName, r.qty
       FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id
       WHERE r.dish_id = ?`
    )
    .all(dishId) as unknown as EffectiveLine[];
  const lines: EffectiveLine[] = base.map((l) => ({ ...l, source: "recipe" as const }));
  for (const m of mods) {
    if (m.kind === "remove") {
      const idx = lines.findIndex((l) => l.ingredientId === m.ingredientId);
      if (idx >= 0) lines.splice(idx, 1);
    } else if (m.kind === "substitute") {
      if (!m.replacesIngredientId)
        throw new ApiError(400, ERR.VALIDATION, "substitute requires replacesIngredientId");
      const idx = lines.findIndex((l) => l.ingredientId === m.replacesIngredientId);
      if (idx < 0)
        throw new ApiError(
          400,
          ERR.VALIDATION,
          `ingredient ${m.replacesIngredientId} is not in the recipe`
        );
      const qty = m.qty && m.qty > 0 ? m.qty : lines[idx].qty;
      const name = ingredientName(ctx, m.ingredientId);
      lines.splice(idx, 1, {
        ingredientId: m.ingredientId,
        ingredientName: name,
        qty,
        source: "substitute",
      });
    } else if (m.kind === "add") {
      if (!m.qty || m.qty <= 0)
        throw new ApiError(400, ERR.VALIDATION, "add requires positive qty");
      const name = ingredientName(ctx, m.ingredientId);
      lines.push({ ingredientId: m.ingredientId, ingredientName: name, qty: m.qty, source: "add" });
    }
  }
  return lines;
}

function ingredientName(ctx: Ctx, id: number): string {
  const row = ctx.db.prepare("SELECT name FROM ingredients WHERE id = ?").get(id) as
    | { name: string }
    | undefined;
  if (!row) throw new ApiError(400, ERR.VALIDATION, `unknown ingredient ${id}`);
  return row.name;
}

export interface AllergenConflict {
  allergen: string;
  ingredient: string;
  source: string;
}

/** Throws ALLERGEN_CONFLICT listing every conflicting ingredient source. */
export function checkAllergens(
  ctx: Ctx,
  dinerId: number,
  lines: EffectiveLine[]
): void {
  const allergies = ctx.db
    .prepare(
      `SELECT a.id, a.code FROM diner_allergies da
       JOIN allergens a ON a.id = da.allergen_id WHERE da.diner_id = ?`
    )
    .all(dinerId) as { id: number; code: string }[];
  if (!allergies.length) return;
  const conflicts: AllergenConflict[] = [];
  const stmt = ctx.db.prepare(
    `SELECT a.code FROM ingredient_allergens ia
     JOIN allergens a ON a.id = ia.allergen_id WHERE ia.ingredient_id = ?`
  );
  for (const line of lines) {
    const ing = (stmt.all(line.ingredientId) as { code: string }[]).map((r) => r.code);
    for (const al of allergies) {
      if (ing.includes(al.code))
        conflicts.push({
          allergen: al.code,
          ingredient: line.ingredientName,
          source: line.source,
        });
    }
  }
  if (conflicts.length)
    throw conflict(
      ERR.ALLERGEN_CONFLICT,
      `allergen conflict: ${conflicts.map((c) => `${c.allergen} via ${c.ingredient}`).join("; ")}`,
      { conflicts }
    );
}

/** Reserve stock for `servings` of the effective lines. Throws INSUFFICIENT_STOCK. */
export function reserveStock(ctx: Ctx, lines: EffectiveLine[], servings: number): void {
  const get = ctx.db.prepare("SELECT stock_qty, reserved_qty, name FROM ingredients WHERE id = ?");
  const upd = ctx.db.prepare(
    "UPDATE ingredients SET reserved_qty = reserved_qty + ? WHERE id = ?"
  );
  const mv = ctx.db.prepare(
    `INSERT INTO inventory_moves (ingredient_id, delta_stock, delta_reserved, reason, created_at)
     VALUES (?, 0, ?, 'reserve', ?)`
  );
  const shortages: { ingredient: string; need: number; available: number }[] = [];
  for (const l of lines) {
    const row = get.get(l.ingredientId) as { stock_qty: number; reserved_qty: number; name: string };
    const need = l.qty * servings;
    if (row.stock_qty - row.reserved_qty < need - 1e-9)
      shortages.push({
        ingredient: row.name,
        need,
        available: row.stock_qty - row.reserved_qty,
      });
  }
  if (shortages.length)
    throw conflict(ERR.INSUFFICIENT_STOCK, "insufficient stock", { shortages });
  for (const l of lines) {
    const need = l.qty * servings;
    upd.run(need, l.ingredientId);
    mv.run(l.ingredientId, need, ctx.now());
  }
}

/** Convert reserved stock into consumed stock (on serving). */
export function consumeStock(ctx: Ctx, lines: EffectiveLine[], servings: number): void {
  const upd = ctx.db.prepare(
    `UPDATE ingredients SET stock_qty = stock_qty - ?, reserved_qty = reserved_qty - ?
     WHERE id = ? AND stock_qty >= ? AND reserved_qty >= ?`
  );
  const mv = ctx.db.prepare(
    `INSERT INTO inventory_moves (ingredient_id, delta_stock, delta_reserved, reason, created_at)
     VALUES (?, ?, ?, 'consume', ?)`
  );
  for (const l of lines) {
    const q = l.qty * servings;
    const r = upd.run(q, q, l.ingredientId, q, q);
    if (r.changes !== 1)
      throw conflict(ERR.INVALID_STATE, `stock invariant violated for ingredient ${l.ingredientId}`);
    mv.run(l.ingredientId, -q, -q, ctx.now());
  }
}

/** Release a reservation without consuming (cancellation). */
export function releaseStock(ctx: Ctx, lines: EffectiveLine[], servings: number): void {
  const upd = ctx.db.prepare(
    "UPDATE ingredients SET reserved_qty = reserved_qty - ? WHERE id = ? AND reserved_qty >= ?"
  );
  const mv = ctx.db.prepare(
    `INSERT INTO inventory_moves (ingredient_id, delta_stock, delta_reserved, reason, created_at)
     VALUES (?, 0, ?, 'release', ?)`
  );
  for (const l of lines) {
    const q = l.qty * servings;
    const r = upd.run(q, l.ingredientId, q);
    if (r.changes !== 1)
      throw conflict(ERR.INVALID_STATE, `reserved invariant violated for ingredient ${l.ingredientId}`);
    mv.run(l.ingredientId, -q, ctx.now());
  }
}

/** Restock returned food ingredients (only when marked restockable). */
export function restock(ctx: Ctx, lines: EffectiveLine[], servings: number): void {
  const upd = ctx.db.prepare("UPDATE ingredients SET stock_qty = stock_qty + ? WHERE id = ?");
  const mv = ctx.db.prepare(
    `INSERT INTO inventory_moves (ingredient_id, delta_stock, delta_reserved, reason, created_at)
     VALUES (?, ?, 0, 'restock', ?)`
  );
  for (const l of lines) {
    const q = l.qty * servings;
    upd.run(q, l.ingredientId);
    mv.run(l.ingredientId, q, ctx.now());
  }
}
