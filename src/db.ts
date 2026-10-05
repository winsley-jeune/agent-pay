import pg from "pg";
import { config } from "./config.js";

// bigint columns hold cents; every amount we store fits safely in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// ...including bigint[] (e.g. array_agg of cents). 1016 is the int8[] type oid.
const parseTextArray = pg.types.getTypeParser(1016 as never);
pg.types.setTypeParser(1016 as never, (v: string) => (parseTextArray(v) as (string | null)[]).map((x) => (x === null ? null : Number(x))));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url = config.databaseUrl): Db {
  return new pg.Pool({ connectionString: url, max: 20 });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}
