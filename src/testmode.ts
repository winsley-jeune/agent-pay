import type { AgentKey } from "./auth.js";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { balance, lockAccount, post, systemAccount } from "./ledger.js";

// Test keys (ap_test_...) let developers build against AgentPay without real
// money: they spend pretend credits from the owner's test wallet, providers get
// an X-AgentPay-Test header and aren't paid, and the key can approve its own
// call approvals so automated tests run end to end. Test keys only reach the
// paid-call endpoints; nothing else (subscriptions, envelopes, browsing...)
// is open to them, because those touch real money or real accounts.

/** Agent API paths a test key may use. */
export function testKeyAllowed(method: string, path: string): boolean {
  if (path.startsWith("/api/agent/test/")) return true;
  if (method === "GET" && ["/api/agent/tools", "/api/agent/balance", "/api/agent/controls/policy"].includes(path)) return true;
  if (method === "GET" && /^\/api\/agent\/approvals\/[^/]+$/.test(path)) return true;
  return method === "POST" && ["/api/agent/quote", "/api/agent/call", "/api/agent/controls/policy/check"].includes(path);
}

function requireTest(agentKey: AgentKey) {
  if (!agentKey.test) throw new AppError(403, "not_test_key", "only test keys (ap_test_...) can do this");
}

/** Add pretend credits to the test wallet. */
export async function addTestCredits(db: Db, agentKey: AgentKey, amountCents: number) {
  requireTest(agentKey);
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 100_000) throw new AppError(400, "invalid_amount", "amountCents must be 1 to 100000");
  return withTx(db, async (tx) => {
    await lockAccount(tx, agentKey.walletAccountId);
    await post(tx, "test", [{ accountId: await systemAccount(tx, "test_sink"), amountCents: -amountCents }, { accountId: agentKey.walletAccountId, amountCents }], "test wallet: pretend credits");
    return { test: true, walletBalanceCents: await balance(tx, agentKey.walletAccountId) };
  });
}

/** A test key approves its own pending call approval, standing in for the owner's passkey. */
export async function approveTestCall(db: Db, agentKey: AgentKey, approvalId: string) {
  requireTest(agentKey);
  const { rowCount } = await db.query(
    "UPDATE approvals SET status = 'approved', decided_at = now() WHERE id = $1 AND agent_key_id = $2 AND kind = 'call' AND status = 'pending'",
    [approvalId, agentKey.id],
  );
  if (!rowCount) throw new AppError(404, "not_found", "no pending call approval for this test key with that id");
  return { id: approvalId, status: "approved", test: true, message: "Approved for testing. Retry the call with this approvalId." };
}
