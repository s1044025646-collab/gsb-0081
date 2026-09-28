import { Ctx } from "../src/db/connection.js";

/** Fictional restaurant fixture: ingredients, allergens, stations, tables,
 *  two menu versions (same dish, different recipes), diners with allergies. */
export function seedFixtures(ctx: Ctx) {
  const { db } = ctx;
  const has = db.prepare("SELECT COUNT(*) AS c FROM stations").get() as { c: number };
  if (has.c > 0) return undefined; // idempotent
  const insIng = db.prepare("INSERT INTO ingredients (name, unit, stock_qty) VALUES (?, 'g', ?)");
  const ing = (name: string, stock: number) => Number(insIng.run(name, stock).lastInsertRowid);
  const chicken = ing("鸡胸肉", 5000);
  const peanutSauce = ing("花生酱", 800);
  const soySauce = ing("酱油", 2000);
  const rice = ing("米饭", 10000);
  const shrimp = ing("虾仁", 1500);
  const tofu = ing("豆腐", 2000);
  const scallion = ing("葱花", 500);
  const chiliOil = ing("辣椒油", 600);
  const insAl = db.prepare("INSERT INTO allergens (code, label) VALUES (?, ?)");
  const al = (code: string, label: string) => Number(insAl.run(code, label).lastInsertRowid);
  const peanut = al("peanut", "花生");
  const soy = al("soy", "大豆");
  const shellfish = al("shellfish", "甲壳类");
  const link = db.prepare(
    "INSERT INTO ingredient_allergens (ingredient_id, allergen_id) VALUES (?, ?)"
  );
  link.run(peanutSauce, peanut);
  link.run(soySauce, soy);
  link.run(tofu, soy);
  link.run(shrimp, shellfish);
  const insSt = db.prepare("INSERT INTO stations (code, name) VALUES (?, ?)");
  insSt.run("hot", "热厨");
  insSt.run("cold", "冷厨");
  insSt.run("pass", "出餐口");
  const insT = db.prepare("INSERT INTO tables (label) VALUES (?)");
  const t1 = Number(insT.run("A1").lastInsertRowid);
  const t2 = Number(insT.run("A2").lastInsertRowid);
  const t3 = Number(insT.run("B1").lastInsertRowid);
  const insD = db.prepare("INSERT INTO diners (table_id, name) VALUES (?, ?)");
  const d1 = Number(insD.run(t1, "张三").lastInsertRowid);
  const d2 = Number(insD.run(t2, "李四").lastInsertRowid);
  const d3 = Number(insD.run(t3, "王五").lastInsertRowid);
  const da = db.prepare("INSERT INTO diner_allergies (diner_id, allergen_id) VALUES (?, ?)");
  da.run(d1, peanut);
  da.run(d3, soy);
  return {
    ingredients: { chicken, peanutSauce, soySauce, rice, shrimp, tofu, scallion, chiliOil },
    allergens: { peanut, soy, shellfish },
    tables: { t1, t2, t3 },
    diners: { d1, d2, d3 },
  };
}

/** Two menu versions of the same dish name (different recipes). */
export function seedMenus(ctx: Ctx) {
  const { db } = ctx;
  const has = db.prepare("SELECT COUNT(*) AS c FROM menu_versions").get() as { c: number };
  if (has.c > 0) return undefined;
  const ingId = (name: string) =>
    (db.prepare("SELECT id FROM ingredients WHERE name = ?").get(name) as { id: number }).id;
  const mkMenu = db.prepare(
    "INSERT INTO menu_versions (name, status, created_at) VALUES (?, 'draft', ?)"
  );
  const mkDish = db.prepare(
    "INSERT INTO dishes (menu_version_id, name, station, price_cents) VALUES (?, ?, ?, ?)"
  );
  const mkRec = db.prepare("INSERT INTO recipes (dish_id, ingredient_id, qty) VALUES (?, ?, ?)");
  // v1: 宫保鸡丁 with peanut sauce
  const v1 = Number(mkMenu.run("2026春季菜单", ctx.now()).lastInsertRowid);
  const kungpao1 = Number(mkDish.run(v1, "宫保鸡丁", "hot", 3800).lastInsertRowid);
  mkRec.run(kungpao1, ingId("鸡胸肉"), 200);
  mkRec.run(kungpao1, ingId("花生酱"), 30);
  mkRec.run(kungpao1, ingId("辣椒油"), 10);
  const salad = Number(mkDish.run(v1, "凉拌豆腐", "cold", 1800).lastInsertRowid);
  mkRec.run(salad, ingId("豆腐"), 150);
  mkRec.run(salad, ingId("葱花"), 5);
  const riceDish = Number(mkDish.run(v1, "米饭", "pass", 300).lastInsertRowid);
  mkRec.run(riceDish, ingId("米饭"), 250);
  // v2: same dish name, peanut-free recipe
  const v2 = Number(mkMenu.run("2026夏季菜单", ctx.now()).lastInsertRowid);
  const kungpao2 = Number(mkDish.run(v2, "宫保鸡丁", "hot", 4000).lastInsertRowid);
  mkRec.run(kungpao2, ingId("鸡胸肉"), 200);
  mkRec.run(kungpao2, ingId("酱油"), 15);
  mkRec.run(kungpao2, ingId("辣椒油"), 10);
  const shrimpSalad = Number(mkDish.run(v2, "虾仁沙拉", "cold", 3200).lastInsertRowid);
  mkRec.run(shrimpSalad, ingId("虾仁"), 120);
  mkRec.run(shrimpSalad, ingId("葱花"), 5);
  db.prepare("UPDATE menu_versions SET status = 'active' WHERE id = ?").run(v1);
  return { v1, v2, dishes: { kungpao1, salad, riceDish, kungpao2, shrimpSalad } };
}
