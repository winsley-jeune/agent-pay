import express from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import {
  addItems,
  cancelList,
  checkImage,
  createList,
  getList,
  listLists,
  markOrdered,
  parseTypedList,
  readListWithClaude,
  reopenList,
  requestOrderApproval,
  updateItem,
  updateList,
  type PhotoReader,
} from "./grocery.js";
import { h, parse } from "./http.js";

const store = z.enum(["walmart", "whole_foods"]);
const item = z.object({
  name: z.string().min(1).max(120),
  quantity: z.number().positive().nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  notes: z.string().max(200).nullable().optional(),
  category: z.string().max(40).nullable().optional(),
});

/** Grocery routes for owners (/api/grocery) and agents (/api/agent/grocery). */
export function groceryRoutes(db: Db, as: "owner" | "agent", readPhoto: PhotoReader = readListWithClaude) {
  const r = express.Router();
  const userId = (req: express.Request) => (as === "owner" ? req.user!.id : req.agentKey!.userId);
  const agentKey = (req: express.Request) => (as === "agent" ? req.agentKey! : null);

  r.get("/", h(async (req) => ({ lists: await listLists(db, userId(req)) })));
  r.post(
    "/",
    h(async (req) => {
      const body = parse(z.object({ title: z.string().max(100).optional(), store: store.optional(), items: z.array(item).max(200).optional(), text: z.string().max(10_000).optional() }), req.body);
      const items = body.items ?? (body.text ? parseTypedList(body.text) : []);
      return { list: await createList(db, userId(req), { title: body.title, store: body.store, items, source: as === "agent" ? "agent" : "typed" }, agentKey(req)) };
    }),
  );
  // Photos are large; this route gets its own body limit (mounted before the global JSON parser).
  r.post(
    "/photo",
    h(async (req) => {
      const body = parse(z.object({ imageBase64: z.string().min(16), mediaType: z.string(), store: store.optional(), title: z.string().max(100).optional() }), req.body);
      const mediaType = checkImage(body.imageBase64, body.mediaType);
      const read = await readPhoto(body.imageBase64, mediaType);
      const list = await createList(db, userId(req), { title: body.title ?? read.title, store: body.store, items: read.items, source: "photo", unreadable: read.unreadable }, agentKey(req));
      return { list, unreadable: read.unreadable };
    }),
  );
  r.get("/:id", h(async (req) => ({ list: await getList(db, userId(req), String(req.params.id)) })));
  r.patch(
    "/:id",
    h(async (req) => ({
      list: await updateList(db, userId(req), String(req.params.id), parse(z.object({ title: z.string().max(100).optional(), store: store.nullable().optional(), status: z.enum(["draft", "shopping"]).optional() }), req.body)),
    })),
  );
  r.post("/:id/items", h(async (req) => ({ list: await addItems(db, userId(req), String(req.params.id), parse(z.object({ items: z.array(item).min(1).max(100) }), req.body).items) })));
  r.patch(
    "/:id/items/:itemId",
    h(async (req) => {
      const u = parse(
        z.object({
          status: z.enum(["needed", "in_cart", "substituted", "unavailable", "removed"]).optional(),
          name: z.string().max(120).optional(),
          quantity: z.number().positive().nullable().optional(),
          unit: z.string().max(20).nullable().optional(),
          notes: z.string().max(200).nullable().optional(),
          productName: z.string().max(200).nullable().optional(),
          productUrl: z.url().max(2000).nullable().optional(),
          priceCents: z.number().int().nonnegative().max(10_000_000).nullable().optional(),
          substituteNote: z.string().max(200).nullable().optional(),
        }),
        req.body,
      );
      return { list: await updateItem(db, userId(req), String(req.params.id), Number(req.params.itemId), u) };
    }),
  );
  r.post("/:id/request-approval", h(async (req) => requestOrderApproval(db, userId(req), String(req.params.id), agentKey(req))));
  r.post(
    "/:id/ordered",
    h(async (req) => {
      const body = parse(z.object({ orderNumber: z.string().max(80).optional(), totalCents: z.number().int().positive() }), req.body);
      return { list: await markOrdered(db, userId(req), String(req.params.id), body, as === "agent") };
    }),
  );
  if (as === "owner") {
    r.post("/:id/reopen", h(async (req) => ({ list: await reopenList(db, userId(req), String(req.params.id)) })));
    r.post(
      "/:id/cancel",
      h(async (req) => {
        await cancelList(db, userId(req), String(req.params.id));
      }),
    );
  }
  return r;
}
