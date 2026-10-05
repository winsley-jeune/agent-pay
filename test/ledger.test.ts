import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { withTx } from "../src/db.js";
import { balance, post, systemAccount } from "../src/ledger.js";
import { freshDb, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

describe("ledger", () => {
  it("rejects an unbalanced transaction in code", async () => {
    const { user } = await setup(db);
    await expect(
      withTx(db, (tx) => post(tx, "dev_credit", [{ accountId: user.walletAccountId, amountCents: 500 }])),
    ).rejects.toThrow(/unbalanced/);
  });

  it("rejects an unbalanced transaction in the database", async () => {
    const { user } = await setup(db);
    await expect(
      withTx(db, async (tx) => {
        const { rows } = await tx.query("INSERT INTO ledger_txns (type) VALUES ('dev_credit') RETURNING id");
        await tx.query("INSERT INTO ledger_entries (txn_id, account_id, amount_cents) VALUES ($1, $2, 500)", [rows[0].id, user.walletAccountId]);
      }),
    ).rejects.toThrow(/does not balance/);
    expect(await balance(db, user.walletAccountId)).toBe(0);
  });

  it("is append-only", async () => {
    const { user } = await setup(db, { credit: 1000 });
    await expect(db.query("UPDATE ledger_entries SET amount_cents = 999999 WHERE account_id = $1", [user.walletAccountId])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query("DELETE FROM ledger_entries")).rejects.toThrow(/append-only/);
  });

  it("computes balance from entries", async () => {
    const { user } = await setup(db, { credit: 1000 });
    const clearing = await systemAccount(db, "dev_clearing");
    expect(await balance(db, user.walletAccountId)).toBe(1000);
    expect(await balance(db, clearing)).toBeLessThanOrEqual(-1000);
  });

  it("rejects fractional cents", async () => {
    const { user } = await setup(db);
    const clearing = await systemAccount(db, "dev_clearing");
    await expect(
      withTx(db, (tx) =>
        post(tx, "dev_credit", [
          { accountId: clearing, amountCents: -1.5 },
          { accountId: user.walletAccountId, amountCents: 1.5 },
        ]),
      ),
    ).rejects.toThrow(/integer cents/);
  });
});
