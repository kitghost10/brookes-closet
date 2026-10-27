import { createDb, runMigrations, type Db } from "../src/lib/db";
import { registerUser } from "../src/lib/users";
import { reviewCreatorVerification } from "../src/lib/catalog";
import { fulfillCheckout, startCheckout } from "../src/lib/commerce";
import { q, q1 } from "../src/lib/db";
import { resetRateLimits } from "../src/lib/rate-limit";

export async function freshDb(): Promise<Db> {
  const db = await createDb({}); // in-memory embedded Postgres
  await runMigrations(db);
  (globalThis as any).__bcDb = Promise.resolve(db);
  resetRateLimits();
  return db;
}

let n = 0;
const uniq = () => `${Date.now()}${++n}`;

export async function mkUser(opts: { role?: "member" | "moderator" | "admin"; verified?: boolean; status?: string } = {}) {
  const email = `u${uniq()}@test.example`;
  const { id } = await registerUser({ email, password: "correct horse battery", adult: true, terms: true });
  await q(`update users set role=$2, status=$3, email_verified_at=$4 where id=$1`, [
    id, opts.role ?? "member", opts.status ?? "active", opts.verified === false ? null : new Date(),
  ]);
  return { id, email };
}

export async function mkCreator(opts: { approved?: boolean } = {}) {
  const admin = await mkUser({ role: "admin" });
  const c = await q1<{ id: string }>(
    `insert into creators (slug, display_name) values ($1,'Test Creator') returning id`, [`c-${uniq()}`]);
  if (opts.approved !== false) {
    await reviewCreatorVerification({
      creatorId: c!.id, reviewerId: admin.id, decision: "approve", ageVerified: true, consentOnFile: true,
      consentSignedAt: new Date(), documentRef: "TEST-REF", notes: null,
    });
  }
  return { id: c!.id, adminId: admin.id };
}

export async function mkContent(creatorId: string, tier: "public" | "free" | "package" | "subscription", status = "published") {
  const r = await q1<{ id: string }>(
    `insert into content_items (creator_id, title, kind, access_level, status, storage_key, mime_type, size_bytes, published_at)
     values ($1,'Item','photo',$2,$3,$4,'image/png',10, now()) returning id`,
    [creatorId, tier, status, `k/${uniq()}.png`]);
  return r!.id;
}

export async function mkPackage(contentIds: string[] = [], collectionIds: string[] = [], active = true) {
  const p = await q1<{ id: string }>(
    `insert into packages (slug, name, price_cents, active) values ($1,'Pkg',1500,$2) returning id`, [`p-${uniq()}`, active]);
  for (const c of contentIds) await q(`insert into package_items (package_id, content_id) values ($1,$2)`, [p!.id, c]);
  for (const c of collectionIds) await q(`insert into package_items (package_id, collection_id) values ($1,$2)`, [p!.id, c]);
  return p!.id;
}

export async function mkPlan(creatorId: string | null = null, active = true) {
  const p = await q1<{ id: string }>(
    `insert into membership_plans (slug, name, price_cents, creator_id, active) values ($1,'Plan',999,$2,$3) returning id`,
    [`pl-${uniq()}`, creatorId, active]);
  return p!.id;
}

export async function buyPackage(userId: string, packageId: string, now = new Date()) {
  const url = await startCheckout(userId, "package", packageId);
  return fulfillCheckout(url.split("/").pop()!, now);
}
export async function subscribe(userId: string, planId: string, now = new Date()) {
  const url = await startCheckout(userId, "plan", planId);
  return fulfillCheckout(url.split("/").pop()!, now);
}

export const viewerOf = async (userId: string) => {
  const u = await q1<any>(`select id, role, status, email_verified_at from users where id=$1`, [userId]);
  return { id: u.id, role: u.role, status: u.status, emailVerified: !!u.email_verified_at } as const;
};
