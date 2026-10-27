import fs from "node:fs";
import path from "node:path";
import { env } from "./env";

export type Row = Record<string, any>;
export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: "pg" | "pglite";
}

/** `url` => node-postgres pool. No url => embedded PGlite (dir persisted, or in-memory if dataDir undefined). */
export async function createDb(opts: { url?: string; dataDir?: string }): Promise<Db> {
  if (opts.url) {
    const { Pool, types } = await import("pg");
    types.setTypeParser(20, (v: string) => parseInt(v, 10)); // bigint -> number
    const pool = new Pool({ connectionString: opts.url, max: 10 });
    const wrap = (c: { query: Function }): Queryable => ({
      async query(text, params) {
        const r = await c.query(text, params);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
      },
      async exec(sql) { await c.query(sql); },
    });
    return {
      driver: "pg",
      ...wrap(pool),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const out = await fn(wrap(client));
          await client.query("COMMIT");
          return out;
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally { client.release(); }
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  if (opts.dataDir) fs.mkdirSync(path.dirname(opts.dataDir), { recursive: true });
  const pg = new PGlite(opts.dataDir ?? "memory://");
  await pg.waitReady;
  const wrap = (c: any): Queryable => ({
    async query(text, params) {
      const r = await c.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql) { await c.exec(sql); },
  });
  return {
    driver: "pglite",
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
}

export async function runMigrations(db: Db, dir = path.resolve(process.cwd(), "db/migrations")): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  const ran: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await db.tx(async (q) => {
      await q.exec(sql);
      await q.query("insert into schema_migrations(name) values ($1)", [file]);
    });
    ran.push(file);
  }
  return ran;
}

const g = globalThis as unknown as { __bcDb?: Promise<Db> };

/** Process-wide singleton. Dev with no DATABASE_URL: embedded Postgres, auto-migrated. */
export function getDb(): Promise<Db> {
  if (!g.__bcDb) {
    g.__bcDb = (async () => {
      if (env.databaseUrl) return createDb({ url: env.databaseUrl });
      if (env.isProd) throw new Error("DATABASE_URL is required in production");
      const db = await createDb({ dataDir: path.resolve(process.cwd(), ".data/pglite") });
      await runMigrations(db);
      return db;
    })();
  }
  return g.__bcDb;
}

export async function q<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]> {
  return (await (await getDb()).query<T>(text, params)).rows;
}
export async function q1<T extends Row = Row>(text: string, params?: unknown[]): Promise<T | null> {
  return (await q<T>(text, params))[0] ?? null;
}
