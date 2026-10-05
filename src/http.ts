import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";
import { AppError } from "./errors.js";

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new AppError(400, "invalid_request", result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return result.data;
}

export function bearer(req: Request): string | null {
  const h = req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** Wrap async handlers so thrown errors reach the error middleware. */
export const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).then((body) => (res.headersSent ? undefined : res.json(body ?? { ok: true })), next);

