import http from "node:http";
import { Ctx } from "../db/connection.js";
import { ApiError, badRequest } from "../domain/errors.js";
import * as menu from "../domain/menu.js";
import * as order from "../domain/order.js";
import * as kitchen from "../domain/kitchen.js";

type Handler = (
  req: http.IncomingMessage,
  body: any,
  q: URLSearchParams,
  m: RegExpMatchArray
) => unknown;

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

function route(method: string, path: string, handler: Handler) {
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$");
  routes.push({ method, pattern, handler });
}

function paging(q: URLSearchParams) {
  const limit = Math.min(Number(q.get("limit") ?? 50), 100);
  const offset = Math.max(Number(q.get("offset") ?? 0), 0);
  if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(offset))
    throw badRequest("invalid limit/offset");
  return { limit, offset };
}

const num = (m: RegExpMatchArray, k: string) => {
  const v = Number(m.groups![k]);
  if (!Number.isInteger(v)) throw badRequest(`invalid ${k}`);
  return v;
};

export function buildServer(ctx: Ctx) {
  route("GET", "/health", () => ({ ok: true }));
  route("POST", "/menus", (_r, b) => menu.createMenuVersion(ctx, b?.name));
  route("GET", "/menus", (_r, _b, q) => {
    const { limit, offset } = paging(q);
    return { data: menu.listMenus(ctx, limit, offset), limit, offset };
  });
  route("POST", "/menus/:id/dishes", (_r, b, _q, m) => menu.addDish(ctx, num(m, "id"), b));
  route("POST", "/menus/:id/activate", (_r, _b, _q, m) => menu.activateMenu(ctx, num(m, "id")));
  route("POST", "/orders", (req, b) =>
    order.createOrder(ctx, {
      ...b,
      idempotencyKey: req.headers["idempotency-key"] as string | undefined,
    }));
  route("GET", "/orders", (_r, _b, q) => {
    const { limit, offset } = paging(q);
    return {
      data: order.listOrders(ctx, limit, offset, q.get("status") ?? undefined),
      limit,
      offset,
    };
  });
  route("GET", "/orders/:id", (_r, _b, _q, m) => order.getOrderView(ctx, num(m, "id")));
  route("POST", "/items/:id/mods", (_r, b, _q, m) =>
    order.modifyItem(ctx, num(m, "id"), b?.mods ?? []));
  route("POST", "/items/:id/cancel", (_r, b, _q, m) =>
    order.cancelItem(ctx, num(m, "id"), b?.qty));
  route("POST", "/items/:id/rush", (_r, b, _q, m) =>
    order.setRush(ctx, num(m, "id"), b?.rush !== false));
  route("POST", "/items/:id/return", (_r, b, _q, m) =>
    kitchen.returnItem(ctx, num(m, "id"), b?.qty, b?.reason, b?.restock === true));
  route("POST", "/tickets/:id/start", (_r, _b, _q, m) => kitchen.startTicket(ctx, num(m, "id")));
  route("POST", "/tickets/:id/complete", (req, b, _q, m) =>
    kitchen.completeTicket(
      ctx,
      num(m, "id"),
      b?.qty,
      (req.headers["idempotency-key"] as string | undefined) ?? b?.idempotencyKey
    ));
  route("POST", "/tickets/:id/redo", (_r, b, _q, m) =>
    kitchen.redoTicket(ctx, num(m, "id"), b?.qty));
  route("GET", "/stations/:code/queue", (_r, _b, q, m) => {
    const { limit, offset } = paging(q);
    return { data: kitchen.stationQueue(ctx, m.groups!.code, limit, offset), limit, offset };
  });

  return http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body =
        req.method === "POST" || req.method === "PUT"
          ? JSON.parse((await readBody(req)) || "{}")
          : undefined;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        const out = await r.handler(req, body, url.searchParams, m);
        return send(200, { ok: true, ...(out as object) });
      }
      send(404, { ok: false, error: { code: "NOT_FOUND", message: "route not found" } });
    } catch (e) {
      if (e instanceof ApiError)
        send(e.status, {
          ok: false,
          error: { code: e.code, message: e.message, details: e.details },
        });
      else if (e instanceof SyntaxError)
        send(400, { ok: false, error: { code: "BAD_JSON", message: "invalid JSON body" } });
      else send(500, { ok: false, error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
