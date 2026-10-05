import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { enforce } from "./policy.js";
import { createAccount } from "./ledger.js";

export interface Provider {
  id: string;
  userId: string;
  name: string;
  accountId: string;
  createdAt: Date;
}

export interface Tool {
  id: string;
  providerId: string;
  providerName: string;
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** quoted: the provider quotes a price per task, up to priceCents. */
  pricingType: "per_call" | "per_unit" | "quoted";
  priceCents: number;
  /** async: the provider answers 202 and reports the result later. */
  mode: "sync" | "async";
  maxJobSeconds: number | null;
  unitsField: string | null;
  maxUnits: number | null;
  upstreamUrl: string;
  upstreamAuth: string | null;
  active: boolean;
}

export type NewTool = Pick<Tool, "slug" | "name" | "description" | "pricingType" | "priceCents" | "upstreamUrl"> &
  Partial<Pick<Tool, "inputSchema" | "unitsField" | "maxUnits" | "upstreamAuth" | "mode" | "maxJobSeconds">>;

export const DEFAULT_MAX_JOB_SECONDS = 3600;

/** What agents and the public catalog see. Never includes the upstream URL or credentials. */
export function publicTool(t: Tool) {
  return {
    slug: t.slug,
    name: t.name,
    description: t.description,
    provider: t.providerName,
    pricing:
      t.pricingType === "per_call"
        ? { type: "per_call" as const, priceCents: t.priceCents }
        : t.pricingType === "quoted"
          ? { type: "quoted" as const, maxPriceCents: t.priceCents, note: "ask for a price with request_task_quote, then call with the quoteId" }
          : { type: "per_unit" as const, priceCentsPerUnit: t.priceCents, unitsField: t.unitsField, maxUnits: t.maxUnits },
    mode: t.mode,
    ...(t.mode === "async" ? { maxJobSeconds: t.maxJobSeconds ?? DEFAULT_MAX_JOB_SECONDS } : {}),
    inputSchema: t.inputSchema,
  };
}

const providerColumns = `id, user_id AS "userId", name, account_id AS "accountId", created_at AS "createdAt"`;

const toolColumns = `t.id, t.provider_id AS "providerId", p.name AS "providerName", t.slug, t.name, t.description,
  t.input_schema AS "inputSchema", t.pricing_type AS "pricingType", t.price_cents AS "priceCents",
  t.units_field AS "unitsField", t.max_units AS "maxUnits", t.upstream_url AS "upstreamUrl",
  t.upstream_auth AS "upstreamAuth", t.mode, t.max_job_seconds AS "maxJobSeconds", t.active`;

export async function createProvider(db: Db, userId: string, name: string): Promise<Provider> {
  return withTx(db, async (tx) => {
    const accountId = await createAccount(tx, "provider", userId);
    const { rows } = await tx.query(
      `INSERT INTO providers (user_id, name, account_id) VALUES ($1, $2, $3) RETURNING ${providerColumns}`,
      [userId, name, accountId],
    );
    return rows[0];
  });
}

export async function providersForUser(q: Db | Tx, userId: string): Promise<Provider[]> {
  const { rows } = await q.query(`SELECT ${providerColumns} FROM providers WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return rows;
}

export async function providerForUser(q: Db | Tx, userId: string, providerId: string): Promise<Provider> {
  const { rows } = await q.query(`SELECT ${providerColumns} FROM providers WHERE id = $1 AND user_id = $2`, [providerId, userId]);
  if (!rows[0]) throw new AppError(404, "not_found", "provider not found");
  return rows[0];
}

export async function createTool(db: Db, providerId: string, t: NewTool): Promise<Tool> {
  // Agents can never pay for these, so they can't be listed either.
  enforce(t.slug, t.name, t.description);
  if (!Number.isSafeInteger(t.priceCents) || t.priceCents < 0) {
    throw new AppError(400, "invalid_price", "priceCents must be a non-negative integer");
  }
  if (t.pricingType === "per_unit" && !t.unitsField) {
    throw new AppError(400, "invalid_pricing", "per_unit tools need a unitsField");
  }
  if (t.pricingType === "quoted" && t.priceCents <= 0) {
    throw new AppError(400, "invalid_pricing", "quoted tools need priceCents: the most a single task can be quoted at");
  }
  try {
    new URL(t.upstreamUrl);
  } catch {
    throw new AppError(400, "invalid_upstream", "upstreamUrl must be an absolute URL");
  }
  const { rows } = await db
    .query(
      `INSERT INTO tools (provider_id, slug, name, description, input_schema, pricing_type, price_cents,
                          units_field, max_units, upstream_url, upstream_auth, mode, max_job_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING slug`,
      [
        providerId,
        t.slug,
        t.name,
        t.description,
        JSON.stringify(t.inputSchema ?? { type: "object" }),
        t.pricingType,
        t.priceCents,
        t.unitsField ?? null,
        t.maxUnits ?? null,
        t.upstreamUrl,
        t.upstreamAuth ?? null,
        t.mode ?? "sync",
        t.mode === "async" ? (t.maxJobSeconds ?? DEFAULT_MAX_JOB_SECONDS) : null,
      ],
    )
    .catch((err) => {
      if (err.code === "23505") throw new AppError(409, "slug_taken", `a tool with slug "${t.slug}" already exists`);
      if (err.code === "23514") throw new AppError(400, "invalid_tool", "slug must be lowercase letters, digits and dashes");
      throw err;
    });
  return (await toolBySlug(db, rows[0].slug, { includeInactive: true }))!;
}

export async function setToolActive(db: Db, providerId: string, slug: string, active: boolean): Promise<void> {
  const { rowCount } = await db.query("UPDATE tools SET active = $1 WHERE provider_id = $2 AND slug = $3", [active, providerId, slug]);
  if (!rowCount) throw new AppError(404, "not_found", "tool not found");
}

export async function toolBySlug(q: Db | Tx, slug: string, opts: { includeInactive?: boolean } = {}): Promise<Tool | null> {
  const { rows } = await q.query(
    `SELECT ${toolColumns} FROM tools t JOIN providers p ON p.id = t.provider_id
      WHERE t.slug = $1 ${opts.includeInactive ? "" : "AND t.active"}`,
    [slug],
  );
  return rows[0] ?? null;
}

export async function toolById(q: Db | Tx, id: string): Promise<Tool | null> {
  const { rows } = await q.query(`SELECT ${toolColumns} FROM tools t JOIN providers p ON p.id = t.provider_id WHERE t.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listTools(q: Db | Tx, opts: { providerId?: string } = {}): Promise<Tool[]> {
  const { rows } = opts.providerId
    ? await q.query(`SELECT ${toolColumns} FROM tools t JOIN providers p ON p.id = t.provider_id WHERE t.provider_id = $1 ORDER BY t.slug`, [opts.providerId])
    : await q.query(`SELECT ${toolColumns} FROM tools t JOIN providers p ON p.id = t.provider_id WHERE t.active ORDER BY t.slug`);
  return rows;
}

/** Price for one call with this input, in cents. Throws if the input can't be priced. */
export function quote(tool: Tool, input: Record<string, unknown>): { amountCents: number; units: number | null } {
  if (tool.pricingType === "per_call") return { amountCents: tool.priceCents, units: null };
  if (tool.pricingType === "quoted") {
    throw new AppError(400, "quote_required", `"${tool.slug}" is priced per task: ask for a price with request_task_quote, then call with the quoteId`);
  }
  const units = input[tool.unitsField!];
  if (typeof units !== "number" || !Number.isInteger(units) || units < 1) {
    throw new AppError(400, "invalid_units", `input.${tool.unitsField} must be a positive integer`);
  }
  if (tool.maxUnits !== null && units > tool.maxUnits) {
    throw new AppError(400, "too_many_units", `input.${tool.unitsField} may be at most ${tool.maxUnits}`);
  }
  return { amountCents: units * tool.priceCents, units };
}
