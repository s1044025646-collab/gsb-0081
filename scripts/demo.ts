/* End-to-end demo against a throwaway DB on an auto-assigned local port.
 * Run: npm run demo   (repeatable; uses a temp db file each run) */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, makeCtx } from "../src/db/connection.js";
import { seedFixtures, seedMenus } from "../fixtures/seed.js";
import { buildServer } from "../src/api/server.js";

const dir = mkdtempSync(join(tmpdir(), "resto-demo-"));
const db = openDb(join(dir, "demo.db"));
migrate(db);
const ctx = makeCtx(db);
const fx = seedFixtures(ctx)!;
const menus = seedMenus(ctx)!;

const server = buildServer(ctx);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
console.log(`demo server: ${base}`);

async function api(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const show = (label: string, v: unknown) =>
  console.log(`\n== ${label} ==\n${JSON.stringify(v, null, 2)}`);

show(
  "1. 花生过敏顾客点宫保鸡丁(含花生酱) -> 被阻断",
  await api("POST", "/orders", {
    tableId: fx.tables.t1,
    dinerId: fx.diners.d1,
    menuVersionId: menus.v1,
    items: [{ dishId: menus.dishes.kungpao1, qty: 1 }],
  })
);

const o = await api(
  "POST",
  "/orders",
  {
    tableId: fx.tables.t2,
    dinerId: fx.diners.d2,
    menuVersionId: menus.v1,
    items: [
      { dishId: menus.dishes.kungpao1, qty: 2, rush: true },
      { dishId: menus.dishes.riceDish, qty: 2, dependsOnItemIndex: 0 },
    ],
  },
  "demo-order-1"
);
show("2. 下单成功(宫保鸡丁x2 加急 + 米饭x2 依赖前菜)", o);
show(
  "   重复同 key 下单 -> 幂等返回",
  await api(
    "POST",
    "/orders",
    {
      tableId: fx.tables.t2,
      dinerId: fx.diners.d2,
      menuVersionId: menus.v1,
      items: [{ dishId: menus.dishes.kungpao1, qty: 2 }],
    },
    "demo-order-1"
  )
);

const [kungpaoTicket, riceTicket] = o.json.ticketIds;
show("3. 米饭依赖未满足 -> 开工被拒", await api("POST", `/tickets/${riceTicket}/start`));
show("4. 热厨开工", await api("POST", `/tickets/${kungpaoTicket}/start`));
show(
  "   部分完工 x1",
  await api("POST", `/tickets/${kungpaoTicket}/complete`, { qty: 1 }, "demo-serve-1")
);
show(
  "   同 key 重复完工 -> 不重复扣料",
  await api("POST", `/tickets/${kungpaoTicket}/complete`, { qty: 1 }, "demo-serve-1")
);

const itemId = o.json.itemIds[0];
const mod = await api("POST", `/items/${itemId}/mods`, {
  mods: [{ kind: "add", ingredientId: fx.ingredients.scallion, qty: 5 }],
});
show("5. 已开工菜品加料 -> 原票作废并生成替代票", mod);
const newTicket = mod.json.newTicket;
show("   对原票完工 -> 拒绝(已作废)", await api("POST", `/tickets/${kungpaoTicket}/complete`, { qty: 1 }));
show("   新票开工", await api("POST", `/tickets/${newTicket}/start`));
show("   新票完工", await api("POST", `/tickets/${newTicket}/complete`, { qty: 1 }));
show("6. 米饭开工", await api("POST", `/tickets/${riceTicket}/start`));
show("   完工 x2", await api("POST", `/tickets/${riceTicket}/complete`, { qty: 2 }));
show("7. 订单最终状态", await api("GET", `/orders/${o.json.orderId}`));
show("8. 热厨队列", await api("GET", "/stations/hot/queue"));

server.close();
db.close();
rmSync(dir, { recursive: true, force: true });
console.log("\ndemo done.");
