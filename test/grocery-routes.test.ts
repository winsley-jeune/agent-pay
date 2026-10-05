import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { groceryRoutes } from "../src/grocery-routes.js";
import type { PhotoReader } from "../src/grocery.js";
import { freshDb, setup } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
let seen: { bytes: number; mediaType: string }[] = [];

// Stand-in for Claude: returns a fixed reading so the route can be tested without an API key.
const fakeReader: PhotoReader = async (b64, mediaType) => {
  seen.push({ bytes: Buffer.from(b64, "base64").length, mediaType });
  return {
    title: "Saturday shop",
    items: [
      { name: "whole milk", quantity: 1, unit: "gallon", notes: null, category: "dairy & eggs" },
      { name: "bananas", quantity: null, unit: null, notes: null, category: "produce" },
    ],
    unreadable: ["chx stck?"],
  };
};

beforeAll(async () => {
  db = await freshDb();
  const { user } = await setup(db);
  const app = express();
  app.use("/photo-test/photo", express.json({ limit: "8mb" }));
  app.use(express.json({ limit: "256kb" }));
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use("/photo-test", groceryRoutes(db, "owner", fakeReader));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: { code: err.code ?? err.type, message: err.message } });
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

describe("photo route", () => {
  it("accepts a phone-sized photo, reads it and creates the list", async () => {
    seen = [];
    const photo = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64"); // ~4 MB as base64, over the normal 256 KB limit
    const r = await post("/photo-test/photo", { imageBase64: photo, mediaType: "image/jpeg", store: "whole_foods" });
    expect(r.status).toBe(200);
    expect(seen).toEqual([{ bytes: 3 * 1024 * 1024, mediaType: "image/jpeg" }]);
    expect(r.body.unreadable).toEqual(["chx stck?"]);
    expect(r.body.list).toMatchObject({ title: "Saturday shop", source: "photo", store: "whole_foods", unreadable: ["chx stck?"] });
    expect(r.body.list.items.map((i: any) => [i.name, i.quantity, i.unit])).toEqual([["whole milk", 1, "gallon"], ["bananas", null, null]]);
  });

  it("rejects files that aren't images before calling Claude", async () => {
    seen = [];
    const r = await post("/photo-test/photo", { imageBase64: "JVBERi0xLjQKJVBERi0xLjQK", mediaType: "application/pdf" });
    expect(r).toMatchObject({ status: 400, body: { error: { code: "invalid_image" } } });
    expect(seen).toEqual([]);
  });

  it("keeps the normal small limit on other routes", async () => {
    const r = await post("/photo-test", { text: "x".repeat(300 * 1024) });
    expect(r.status).toBe(413);
  });
});
