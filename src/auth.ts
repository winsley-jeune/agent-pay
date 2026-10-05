import { createHash, randomBytes } from "node:crypto";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { config } from "./config.js";
import type { Level, SpendRule } from "./controls.js";
import { createAccount, post, systemAccount } from "./ledger.js";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export interface User {
  id: string;
  email: string;
  walletAccountId: string;
}

export async function createUser(db: Db, email: string): Promise<{ user: User; token: string }> {
  const token = newToken("ap_owner");
  return withTx(db, async (tx) => {
    const { rows } = await tx
      .query("INSERT INTO users (email, token_hash) VALUES ($1, $2) RETURNING id, email", [email.toLowerCase(), hashToken(token)])
      .catch((err) => {
        if (err.code === "23505") throw new AppError(409, "email_taken", "an account with that email already exists");
        throw err;
      });
    const walletAccountId = await createAccount(tx, "wallet", rows[0].id);
    return { user: { ...rows[0], walletAccountId }, token };
  });
}

export async function userById(q: Db | Tx, id: string): Promise<User | null> {
  const { rows } = await q.query(
    `SELECT u.id, u.email, a.id AS "walletAccountId"
       FROM users u JOIN accounts a ON a.owner_id = u.id AND a.kind = 'wallet'
      WHERE u.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function userByToken(q: Db | Tx, token: string): Promise<User | null> {
  const { rows } = await q.query(
    `SELECT u.id, u.email, a.id AS "walletAccountId"
       FROM users u JOIN accounts a ON a.owner_id = u.id AND a.kind = 'wallet'
      WHERE u.token_hash = $1`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export interface AgentKey {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  walletAccountId: string;
  perCallMaxCents: number | null;
  dailyCapCents: number | null;
  monthlyCapCents: number | null;
  approvalThresholdCents: number | null;
  allowedToolSlugs: string[] | null;
  level: Level;
  spendRules: SpendRule[];
  observeAboveCents: number | null;
  coolingOffUntil: Date | null;
  /** A test key (ap_test_...) spends pretend money from the owner's test wallet; nothing real moves. */
  test: boolean;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface AgentKeyLimits {
  perCallMaxCents?: number | null;
  dailyCapCents?: number | null;
  monthlyCapCents?: number | null;
  approvalThresholdCents?: number | null;
  allowedToolSlugs?: string[] | null;
  level?: Level;
  spendRules?: SpendRule[];
  observeAboveCents?: number | null;
  test?: boolean;
}

const agentKeyColumns = `k.id, k.user_id AS "userId", k.name, k.key_prefix AS "keyPrefix", a.id AS "walletAccountId",
  k.per_call_max_cents AS "perCallMaxCents", k.daily_cap_cents AS "dailyCapCents",
  k.monthly_cap_cents AS "monthlyCapCents", k.approval_threshold_cents AS "approvalThresholdCents",
  k.allowed_tool_slugs AS "allowedToolSlugs", k.level, k.spend_rules AS "spendRules", k.observe_above_cents AS "observeAboveCents",
  k.cooling_off_until AS "coolingOffUntil", k.test, k.revoked_at AS "revokedAt", k.created_at AS "createdAt"`;

// A test key's wallet is the owner's test wallet, so it can never touch real money.
const agentKeyFrom = `agent_keys k JOIN accounts a ON a.owner_id = k.user_id AND a.kind = CASE WHEN k.test THEN 'test_wallet' ELSE 'wallet' END`;

/** Starting pretend balance for a new test wallet. */
export const TEST_WALLET_START_CENTS = 10_000;

/** The owner's test wallet, created with pretend credits the first time. */
export async function ensureTestWallet(tx: Tx, userId: string): Promise<string> {
  const { rows } = await tx.query("SELECT id FROM accounts WHERE owner_id = $1 AND kind = 'test_wallet'", [userId]);
  if (rows[0]) return rows[0].id;
  const id = await createAccount(tx, "test_wallet", userId);
  await post(tx, "test", [{ accountId: await systemAccount(tx, "test_sink"), amountCents: -TEST_WALLET_START_CENTS }, { accountId: id, amountCents: TEST_WALLET_START_CENTS }], "test wallet: pretend credits");
  return id;
}

const limitColumns: Record<Exclude<keyof AgentKeyLimits, "test">, string> = {
  perCallMaxCents: "per_call_max_cents",
  dailyCapCents: "daily_cap_cents",
  monthlyCapCents: "monthly_cap_cents",
  approvalThresholdCents: "approval_threshold_cents",
  allowedToolSlugs: "allowed_tool_slugs",
  level: "level",
  spendRules: "spend_rules",
  observeAboveCents: "observe_above_cents",
};

const columnValue = (field: keyof AgentKeyLimits, v: unknown) => (field === "spendRules" ? JSON.stringify(v ?? []) : v);

export async function createAgentKey(
  db: Db,
  userId: string,
  name: string,
  limits: AgentKeyLimits = {},
): Promise<{ agentKey: AgentKey; key: string }> {
  const key = newToken(limits.test ? "ap_test" : "ap_agent");
  if (limits.test) await withTx(db, (tx) => ensureTestWallet(tx, userId));
  const { rows } = await db.query(
    `INSERT INTO agent_keys (user_id, name, key_prefix, key_hash, per_call_max_cents, daily_cap_cents,
                             monthly_cap_cents, approval_threshold_cents, allowed_tool_slugs, level, spend_rules,
                             observe_above_cents, cooling_off_until, test)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             CASE WHEN $13::int > 0 AND NOT $14 THEN now() + make_interval(hours => $13::int) END, $14) RETURNING id`,
    [
      userId,
      name,
      key.slice(0, 16),
      hashToken(key),
      limits.perCallMaxCents ?? null,
      limits.dailyCapCents ?? null,
      limits.monthlyCapCents ?? null,
      limits.approvalThresholdCents ?? null,
      limits.allowedToolSlugs ?? null,
      limits.level ?? "budget",
      JSON.stringify(limits.spendRules ?? []),
      limits.observeAboveCents ?? null,
      // A new key starts in a cooling-off period (test keys don't need one).
      config.coolingOffHours,
      !!limits.test,
    ],
  );
  const agentKey = await agentKeyById(db, rows[0].id);
  return { agentKey: agentKey!, key };
}

export async function agentKeyById(q: Db | Tx, id: string): Promise<AgentKey | null> {
  const { rows } = await q.query(`SELECT ${agentKeyColumns} FROM ${agentKeyFrom} WHERE k.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function agentKeyByToken(q: Db | Tx, key: string): Promise<AgentKey | null> {
  const { rows } = await q.query(
    `SELECT ${agentKeyColumns} FROM ${agentKeyFrom} WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashToken(key)],
  );
  return rows[0] ?? null;
}

export async function listAgentKeys(q: Db | Tx, userId: string): Promise<AgentKey[]> {
  const { rows } = await q.query(
    `SELECT ${agentKeyColumns} FROM ${agentKeyFrom} WHERE k.user_id = $1 ORDER BY k.created_at DESC`,
    [userId],
  );
  return rows;
}

export async function updateAgentKeyLimits(db: Db, userId: string, id: string, limits: AgentKeyLimits): Promise<AgentKey> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(limitColumns) as [keyof AgentKeyLimits, string][]) {
    if (limits[field] !== undefined) {
      values.push(columnValue(field, limits[field]));
      sets.push(`${column} = $${values.length}`);
    }
  }
  values.push(id, userId);
  const { rowCount } = await db.query(
    `UPDATE agent_keys SET ${sets.length ? sets.join(", ") : "name = name"}
      WHERE id = $${values.length - 1} AND user_id = $${values.length}`,
    values,
  );
  if (!rowCount) throw new AppError(404, "not_found", "agent key not found");
  return (await agentKeyById(db, id))!;
}

export async function revokeAgentKey(db: Db, userId: string, id: string): Promise<void> {
  const { rowCount } = await db.query(
    "UPDATE agent_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    [id, userId],
  );
  if (!rowCount) throw new AppError(404, "not_found", "agent key not found or already revoked");
}
