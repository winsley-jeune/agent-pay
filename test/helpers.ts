import { syncCatalog } from "../src/catalog.js";
import { createAgentKey, createUser, type AgentKeyLimits } from "../src/auth.js";
import { createPool, type Db } from "../src/db.js";
import { resetSystemAccountCache } from "../src/ledger.js";
import { migrate } from "../src/migrate.js";
import { createProvider, createTool, type NewTool } from "../src/registry.js";
import { devCredit } from "../src/wallet.js";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://agentpay:agentpay@localhost:5433/agentpay_test";

export async function freshDb(): Promise<Db> {
  const db = createPool(TEST_URL);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  resetSystemAccountCache();
  await migrate(db);
  await syncCatalog(db);
  return db;
}

let n = 0;
export async function setup(db: Db, opts: { credit?: number; limits?: AgentKeyLimits; tool?: Partial<NewTool> } = {}) {
  n++;
  const { user, token } = await createUser(db, `owner${n}-${Date.now()}@example.com`);
  if (opts.credit) await devCredit(db, user.walletAccountId, opts.credit);
  const { user: providerUser } = await createUser(db, `provider${n}-${Date.now()}@example.com`);
  const provider = await createProvider(db, providerUser.id, "Acme APIs");
  const tool = await createTool(db, provider.id, {
    slug: `tool-${n}`,
    name: "Test tool",
    description: "a test tool",
    pricingType: "per_call",
    priceCents: 100,
    upstreamUrl: "https://provider.example/call",
    ...opts.tool,
  });
  const { agentKey, key } = await createAgentKey(db, user.id, "test agent", opts.limits);
  return { user, token, provider, tool, agentKey, key };
}

/** A fake provider: returns `body` with status `status`, optionally after a delay. */
export function fakeFetch(opts: { status?: number; body?: unknown; delayMs?: number; units?: number; throws?: Error } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.throws) throw opts.throws;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.units !== undefined) headers["x-agentpay-units"] = String(opts.units);
    return new Response(JSON.stringify(opts.body ?? { ok: true }), { status: opts.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Every transaction balances, so the whole ledger must sum to zero. */
export async function ledgerTotal(db: Db): Promise<number> {
  const { rows } = await db.query("SELECT COALESCE(SUM(amount_cents), 0)::bigint AS s FROM ledger_entries");
  return rows[0].s;
}
