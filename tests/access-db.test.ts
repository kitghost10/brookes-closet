import { beforeAll, describe, expect, it } from "vitest";
import { buyPackage, freshDb, mkContent, mkCreator, mkPackage, mkPlan, mkUser, subscribe, viewerOf } from "./helpers";
import { checkContentAccess, loadContent, checkStreamAccess, type StreamRecord } from "../src/lib/access";
import { cancelSubscription, expireLapsedSubscriptions, grantPackage, refundPurchase, renewSubscription, revokeEntitlement, revokeSubscription, suspendUser, startCheckout, CommerceError } from "../src/lib/commerce";
import { q, q1 } from "../src/lib/db";
import { setCreatorStatus, setContentStatus } from "../src/lib/catalog";

let creator: { id: string; adminId: string };

beforeAll(async () => {
  await freshDb();
  creator = await mkCreator();
});

async function can(userId: string | null, contentId: string, now = new Date()) {
  const content = (await loadContent(await (await import("../src/lib/db")).getDb(), contentId))!;
  const viewer = userId ? await viewerOf(userId) : null;
  return (await checkContentAccess(viewer, content, now)).allowed;
}
const DAY = 86400_000;

describe("package purchases (database-backed)", () => {
  it("grants access only after purchase, and only to purchased items", async () => {
    const u = await mkUser();
    const inPkg = await mkContent(creator.id, "package");
    const other = await mkContent(creator.id, "package");
    const pkg = await mkPackage([inPkg]);
    expect(await can(u.id, inPkg)).toBe(false);
    await buyPackage(u.id, pkg);
    expect(await can(u.id, inPkg)).toBe(true);
    expect(await can(u.id, other)).toBe(false);
    expect(await can(null, inPkg)).toBe(false);
  });

  it("collections inside a package unlock their items", async () => {
    const u = await mkUser();
    const item = await mkContent(creator.id, "package");
    const col = await q1<{ id: string }>(`insert into collections (slug,title) values ('col-'||gen_random_uuid(),'C') returning id`);
    await q(`insert into collection_items (collection_id, content_id) values ($1,$2)`, [col!.id, item]);
    const pkg = await mkPackage([], [col!.id]);
    expect(await can(u.id, item)).toBe(false);
    await buyPackage(u.id, pkg);
    expect(await can(u.id, item)).toBe(true);
  });

  it("refund revokes access, records billing history, and is audited", async () => {
    const u = await mkUser();
    const item = await mkContent(creator.id, "package");
    const pkg = await mkPackage([item]);
    const { id: purchaseId } = await buyPackage(u.id, pkg);
    expect(await can(u.id, item)).toBe(true);
    await refundPurchase(purchaseId, creator.adminId);
    expect(await can(u.id, item)).toBe(false);
    const ev = await q(`select type from billing_events where user_id=$1 order by created_at`, [u.id]);
    expect(ev.map((e) => e.type)).toEqual(["charge", "refund"]);
    expect((await q1(`select status from purchases where id=$1`, [purchaseId]))!.status).toBe("refunded");
    expect(await q1(`select 1 from audit_logs where action='purchase.refunded' and entity_id=$1`, [purchaseId])).toBeTruthy();
    await expect(refundPurchase(purchaseId, creator.adminId)).rejects.toThrow(CommerceError); // no double refund
  });

  it("refunded purchase cannot be resurrected by a surviving entitlement row", async () => {
    const u = await mkUser();
    const item = await mkContent(creator.id, "package");
    const { id: purchaseId } = await buyPackage(u.id, await mkPackage([item]));
    await q(`update purchases set status='refunded' where id=$1`, [purchaseId]); // entitlement row left untouched
    expect(await can(u.id, item)).toBe(false);
  });

  it("admin revocation and expiring grants are honored", async () => {
    const u = await mkUser();
    const item = await mkContent(creator.id, "package");
    const pkg = await mkPackage([item]);
    await grantPackage(u.id, pkg, creator.adminId, new Date(Date.now() + DAY));
    expect(await can(u.id, item)).toBe(true);
    expect(await can(u.id, item, new Date(Date.now() + 2 * DAY))).toBe(false); // grant expired
    const ent = await q1<{ id: string }>(`select id from entitlements where user_id=$1`, [u.id]);
    await revokeEntitlement(ent!.id, creator.adminId, "chargeback");
    expect(await can(u.id, item)).toBe(false);
  });

  it("prevents duplicate purchase and unverified-email purchase", async () => {
    const u = await mkUser();
    const pkg = await mkPackage([await mkContent(creator.id, "package")]);
    await buyPackage(u.id, pkg);
    await expect(startCheckout(u.id, "package", pkg)).rejects.toThrow(/already own/);
    const unv = await mkUser({ verified: false });
    await expect(startCheckout(unv.id, "package", pkg)).rejects.toThrow(/verify your email/);
  });

  it("inactive packages cannot be bought", async () => {
    const u = await mkUser();
    const pkg = await mkPackage([], [], false);
    await expect(startCheckout(u.id, "package", pkg)).rejects.toThrow(/not available/);
  });
});

describe("subscriptions and expiry (database-backed)", () => {
  it("grants access for one period and lapses afterwards without any sweeper", async () => {
    const u = await mkUser();
    const item = await mkContent(creator.id, "subscription");
    await subscribe(u.id, await mkPlan());
    expect(await can(u.id, item)).toBe(true);
    expect(await can(u.id, item, new Date(Date.now() + 40 * DAY))).toBe(false);
  });

  it("renewal extends access; the sweeper marks lapsed subs expired", async () => {
    const u = await mkUser();
    const item = await mkContent(creator.id, "subscription");
    const { id: subId } = await subscribe(u.id, await mkPlan());
    await renewSubscription(subId);
    expect(await can(u.id, item, new Date(Date.now() + 40 * DAY))).toBe(true); // 2 periods
    expect(await can(u.id, item, new Date(Date.now() + 70 * DAY))).toBe(false);
    expect(await expireLapsedSubscriptions(new Date(Date.now() + 70 * DAY))).toBeGreaterThanOrEqual(1);
    expect((await q1(`select status from subscriptions where id=$1`, [subId]))!.status).toBe("expired");
  });

  it("cancellation keeps access until period end, blocks renewal, and shows in billing history", async () => {
    const u = await mkUser();
    const item = await mkContent(creator.id, "subscription");
    const { id: subId } = await subscribe(u.id, await mkPlan());
    await cancelSubscription(u.id, subId);
    expect(await can(u.id, item)).toBe(true);
    expect(await can(u.id, item, new Date(Date.now() + 40 * DAY))).toBe(false);
    await expect(renewSubscription(subId)).rejects.toThrow(/cancel/);
    const ev = await q(`select type from billing_events where user_id=$1 order by created_at`, [u.id]);
    expect(ev.map((e) => e.type)).toEqual(["charge", "cancellation"]);
  });

  it("users cannot cancel someone else's subscription", async () => {
    const a = await mkUser(), b = await mkUser();
    const { id: subId } = await subscribe(a.id, await mkPlan());
    await expect(cancelSubscription(b.id, subId)).rejects.toThrow(CommerceError);
  });

  it("staff revocation cuts access immediately", async () => {
    const u = await mkUser();
    const item = await mkContent(creator.id, "subscription");
    const { id: subId } = await subscribe(u.id, await mkPlan());
    await revokeSubscription(subId, creator.adminId, "abuse");
    expect(await can(u.id, item)).toBe(false);
  });

  it("a creator-specific plan does not unlock another creator's content", async () => {
    const other = await mkCreator();
    const u = await mkUser();
    await subscribe(u.id, await mkPlan(other.id));
    expect(await can(u.id, await mkContent(other.id, "subscription"))).toBe(true);
    expect(await can(u.id, await mkContent(creator.id, "subscription"))).toBe(false);
  });

  it("checkout fulfillment is idempotent (no double charge/entitlement on webhook retry)", async () => {
    const u = await mkUser();
    const { fulfillCheckout } = await import("../src/lib/commerce");
    const url = await startCheckout(u.id, "package", await mkPackage([await mkContent(creator.id, "package")]));
    const sid = url.split("/").pop()!;
    const a = await fulfillCheckout(sid), b = await fulfillCheckout(sid);
    expect(a.id).toBe(b.id);
    expect((await q(`select 1 from purchases where user_id=$1`, [u.id])).length).toBe(1);
  });
});

describe("suspension, moderation and creator state", () => {
  it("suspending a user revokes all paid/free access and sessions; reinstating restores", async () => {
    const u = await mkUser();
    const pkgItem = await mkContent(creator.id, "package");
    const free = await mkContent(creator.id, "free");
    await buyPackage(u.id, await mkPackage([pkgItem]));
    await q(`insert into sessions (user_id, token_hash, expires_at) values ($1,'h'||gen_random_uuid(), now()+interval '1 day')`, [u.id]);
    await suspendUser(u.id, creator.adminId, true);
    expect(await can(u.id, pkgItem)).toBe(false);
    expect(await can(u.id, free)).toBe(false);
    expect((await q(`select 1 from sessions where user_id=$1`, [u.id])).length).toBe(0);
    await suspendUser(u.id, creator.adminId, false);
    expect(await can(u.id, pkgItem)).toBe(true);
  });

  it("unpublishing hides content from entitled users; suspended creators are unavailable", async () => {
    const c = await mkCreator();
    const u = await mkUser();
    const item = await mkContent(c.id, "free");
    expect(await can(u.id, item)).toBe(true);
    await setContentStatus(item, "unpublished", c.adminId);
    expect(await can(u.id, item)).toBe(false);
    await setContentStatus(item, "published", c.adminId);
    await setCreatorStatus(c.id, "suspended", c.adminId);
    expect(await can(u.id, item)).toBe(false);
    expect(await can(null, await mkContent(c.id, "public", "draft"))).toBe(false);
  });

  it("unverified-email accounts cannot access free content", async () => {
    const u = await mkUser({ verified: false });
    expect(await can(u.id, await mkContent(creator.id, "free"))).toBe(false);
  });
});

describe("livestream access", () => {
  const stream = async (access: "public" | "subscriber" | "purchase", pkg: string | null = null): Promise<StreamRecord> => ({
    id: "s", creator_id: creator.id, title: "t", description: "", access, package_id: pkg, status: "live",
    scheduled_at: new Date(), provider: null, provider_ref: null, creator_status: "approved", creator_name: "x",
  });
  it("public / subscriber / purchase gating", async () => {
    const u = await mkUser();
    const v = await viewerOf(u.id);
    expect((await checkStreamAccess(null, await stream("public"))).allowed).toBe(true);
    expect((await checkStreamAccess(v, await stream("subscriber"))).allowed).toBe(false);
    await subscribe(u.id, await mkPlan());
    expect((await checkStreamAccess(v, await stream("subscriber"))).allowed).toBe(true);
    const pkg = await mkPackage([]);
    expect((await checkStreamAccess(v, await stream("purchase", pkg))).allowed).toBe(false);
    await buyPackage(u.id, pkg);
    expect((await checkStreamAccess(v, await stream("purchase", pkg))).allowed).toBe(true);
    expect((await checkStreamAccess(null, await stream("subscriber"))).allowed).toBe(false);
  });
});
