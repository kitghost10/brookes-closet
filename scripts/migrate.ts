import { createDb, runMigrations } from "../src/lib/db";
import { env } from "../src/lib/env";
import path from "node:path";

async function main() {
  const db = await createDb(env.databaseUrl ? { url: env.databaseUrl } : { dataDir: path.resolve(".data/pglite") });
  const ran = await runMigrations(db);
  console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date.");
  await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
