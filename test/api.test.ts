import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { seededCtx } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { Ctx } from "../src/db/connection.js";

let server: Server;
let base: string;
let ctx: Ctx;
let fx: any;
let menus: any;

before(async () => {
  const s = seededCtx();
  ctx = s.ctx;
  fx = s.fx;
  menus = s.menus;
  server = buildServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

test("api: validation errors and error codes", async () => {
  const bad = await call("POST", "/orders", { tableId: 1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "BAD_REQUEST");
  const nf = await call("GET", "/orders/9999");
  assert.equal(nf.status, 404);
  const allergen = await call("POST", "/orders", {
    tableId: fx.tables.t1,
    dinerId: fx.diners.d1,
    menuVersionId: menus.v1,
    items: [{ dishId: menus.dishes.kungpao1, qty: 1 }],
  });
  assert.equal(allergen.status, 409);
  assert.equal(allergen.json.error.code, "ALLERGEN_CONFLICT");
  assert.ok(allergen.json.error.details.conflicts.length > 0);
});

test("api: pagination and end-to-end flow over HTTP", async () => {
  const created = await call(
    "POST",
    "/orders",
    {
      tableId: fx.tables.t2,
      dinerId: fx.diners.d2,
      menuVersionId: menus.v1,
      items: [{ dishId: menus.dishes.kungpao1, qty: 2 }],
    },
    { "idempotency-key": "http-order-1" }
  );
  assert.equal(created.status, 200);
  const { orderId, ticketIds } = created.json;
  // repeat with same key -> same order, no new rows
  const again = await call(
    "POST",
    "/orders",
    {
      tableId: fx.tables.t2,
      dinerId: fx.diners.d2,
      menuVersionId: menus.v1,
      items: [{ dishId: menus.dishes.kungpao1, qty: 2 }],
    },
    { "idempotency-key": "http-order-1" }
  );
  assert.equal(again.json.orderId, orderId);
  assert.equal(again.json.duplicated, true);

  const list = await call("GET", "/orders?limit=1&offset=0");
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.limit, 1);

  const q0 = await call("GET", "/stations/hot/queue");
  assert.ok(q0.json.data.some((t: any) => t.ticket_id === ticketIds[0]));

  await call("POST", `/tickets/${ticketIds[0]}/start`);
  const done = await call("POST", `/tickets/${ticketIds[0]}/complete`, { qty: 2 });
  assert.equal(done.status, 200);
  const view = await call("GET", `/orders/${orderId}`);
  assert.equal(view.json.order.status, "served");
  // persisted ticket state
  const t = ctx.db.prepare("SELECT status FROM tickets WHERE id = ?").get(ticketIds[0]) as any;
  assert.equal(t.status, "done");
});

test("api: menu lifecycle and non-active menu rejection", async () => {
  const mv = await call("POST", "/menus", { name: "测试菜单X" });
  const menuId = mv.json.id;
  await call("POST", `/menus/${menuId}/dishes`, {
    name: "白米饭",
    station: "pass",
    priceCents: 200,
    recipe: [{ ingredient: "米饭", qty: 200 }],
  });
  const draftOrder = await call("POST", "/orders", {
    tableId: fx.tables.t2,
    dinerId: fx.diners.d2,
    menuVersionId: menuId,
    items: [{ dishId: 1, qty: 1 }],
  });
  assert.equal(draftOrder.status, 409);
  assert.equal(draftOrder.json.error.code, "MENU_NOT_ACTIVE");
  const act = await call("POST", `/menus/${menuId}/activate`);
  assert.equal(act.json.status, "active");
  // old active menu archived
  const v1 = ctx.db.prepare("SELECT status FROM menu_versions WHERE id = ?").get(menus.v1) as any;
  assert.equal(v1.status, "archived");
});
