import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPool, type Db } from "./db.js";

const dir = fileURLToPath(new URL("../migrations/", import.meta.url));

export async function migrate(db: Db): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
    if (done.has(file)) continue;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(dir + file, "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = createPool();
  migrate(db)
    .then((applied) => console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date"))
    .finally(() => db.end());
}
