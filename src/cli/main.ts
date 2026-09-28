#!/usr/bin/env node
/* CLI for the restaurant backend. Talks to the local HTTP API. */
const BASE = process.env.API_BASE ?? "http://127.0.0.1:8787";

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!json.ok) {
    console.error(`ERROR ${json.error.code}: ${json.error.message}`);
    if (json.error.details) console.error(JSON.stringify(json.error.details, null, 2));
    process.exit(1);
  }
  return json;
}

const show = (label: string, v: unknown) => {
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(v, null, 2));
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const arg = (i: number) => args[i];
  switch (cmd) {
    case "menu:create":
      show("menu created", await api("POST", "/menus", { name: arg(0) }));
      break;
    case "menu:add-dish": {
      // menu:add-dish <menuId> <name> <station> <priceCents> <recipe: name=qty,name=qty>
      const recipe = (arg(4) ?? "").split(",").filter(Boolean).map((p) => {
        const [ingredient, qty] = p.split("=");
        return { ingredient, qty: Number(qty) };
      });
      show(
        "dish added",
        await api("POST", `/menus/${arg(0)}/dishes`, {
          name: arg(1),
          station: arg(2),
          priceCents: Number(arg(3) ?? 0),
          recipe,
        })
      );
      break;
    }
    case "menu:activate":
      show("menu activated", await api("POST", `/menus/${arg(0)}/activate`));
      break;
    case "menu:list":
      show("menus", await api("GET", "/menus"));
      break;
    case "order:create": {
      // order:create <tableId> <dinerId> <menuVersionId> <dishId:qty[:rush]>... [--key K] [--mod itemIdx:kind:ingId[:replacesId:qty]]
      const keyIdx = args.indexOf("--key");
      const key = keyIdx >= 0 ? args[keyIdx + 1] : undefined;
      const modIdx = args.indexOf("--mod");
      const mods: Record<number, any[]> = {};
      if (modIdx >= 0) {
        for (const spec of args[modIdx + 1].split(";")) {
          const [idx, kind, ing, rep, qty] = spec.split(":");
          (mods[Number(idx)] ??= []).push({
            kind,
            ingredientId: Number(ing),
            replacesIngredientId: rep ? Number(rep) : undefined,
            qty: qty ? Number(qty) : undefined,
          });
        }
      }
      const itemArgs = args.slice(3, keyIdx >= 0 ? keyIdx : modIdx >= 0 ? modIdx : undefined);
      const items = itemArgs.map((s, i) => {
        const [dishId, qty, rush] = s.split(":");
        return { dishId: Number(dishId), qty: Number(qty), rush: rush === "rush", mods: mods[i] };
      });
      show(
        "order created",
        await api(
          "POST",
          "/orders",
          { tableId: Number(arg(0)), dinerId: Number(arg(1)), menuVersionId: Number(arg(2)), items },
          key ? { "idempotency-key": key } : {}
        )
      );
      break;
    }
    case "order:show":
      show("order", await api("GET", `/orders/${arg(0)}`));
      break;
    case "order:list":
      show("orders", await api("GET", `/orders${arg(0) ? `?status=${arg(0)}` : ""}`));
      break;
    case "item:modify": {
      // item:modify <itemId> <kind:ingredientId[:replacesId:qty]>...
      const mods = args.slice(1).map((s) => {
        const [kind, ing, rep, qty] = s.split(":");
        return {
          kind,
          ingredientId: Number(ing),
          replacesIngredientId: rep ? Number(rep) : undefined,
          qty: qty ? Number(qty) : undefined,
        };
      });
      const before = await api("GET", `/orders/${await orderOf(arg(0))}`);
      show("before", before.items?.filter?.((i: any) => i.id === Number(arg(0))) ?? before);
      show("modify result", await api("POST", `/items/${arg(0)}/mods`, { mods }));
      break;
    }
    case "item:cancel":
      show("cancelled", await api("POST", `/items/${arg(0)}/cancel`, { qty: Number(arg(1) ?? 1) }));
      break;
    case "item:rush":
      show("rush", await api("POST", `/items/${arg(0)}/rush`, { rush: arg(1) !== "off" }));
      break;
    case "item:return":
      show(
        "returned",
        await api("POST", `/items/${arg(0)}/return`, {
          qty: Number(arg(1) ?? 1),
          reason: arg(2) ?? "顾客退菜",
          restock: arg(3) === "restock",
        })
      );
      break;
    case "ticket:start":
      show("started", await api("POST", `/tickets/${arg(0)}/start`));
      break;
    case "ticket:complete": {
      const before = await api("GET", `/stations/${arg(2) ?? "hot"}/queue`).catch(() => null);
      if (before) show("queue before", before);
      show(
        "completed",
        await api(
          "POST",
          `/tickets/${arg(0)}/complete`,
          { qty: Number(arg(1) ?? 1) },
          arg(3) ? { "idempotency-key": arg(3) } : {}
        )
      );
      break;
    }
    case "ticket:redo":
      show("redo", await api("POST", `/tickets/${arg(0)}/redo`, { qty: Number(arg(1) ?? 1) }));
      break;
    case "queue":
      show(`queue ${arg(0)}`, await api("GET", `/stations/${arg(0)}/queue`));
      break;
    default:
      console.log(`Usage: API_BASE=http://127.0.0.1:PORT tsx src/cli/main.ts <cmd>
  menu:create <name> | menu:add-dish <menuId> <name> <station> <priceCents> <ing=qty,...> | menu:activate <id> | menu:list
  order:create <tableId> <dinerId> <menuVersionId> <dishId:qty[:rush]>... [--key K] [--mod "idx:kind:ingId[:repId:qty];..."]
  order:show <id> | order:list [status]
  item:modify <itemId> <kind:ingId[:repId:qty]>... | item:cancel <itemId> [qty] | item:rush <itemId> [on|off]
  item:return <itemId> [qty] [reason] [restock]
  ticket:start <id> | ticket:complete <id> [qty] [station] [idemKey] | ticket:redo <id> [qty]
  queue <stationCode>`);
  }
}

async function orderOf(itemId: string): Promise<number> {
  // helper for before/after display: find order containing this item
  const orders = await api("GET", "/orders?limit=100");
  for (const o of orders.data) {
    const v = await api("GET", `/orders/${o.id}`);
    if ((v.items as any[]).some((i) => i.id === Number(itemId))) return o.id;
  }
  return 0;
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
