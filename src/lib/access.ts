import { getDb, type Queryable } from "./db";
import {
  evaluateAccess, type AccessDecision, type Grants, type SubscriptionFact, type Tier, type Viewer,
} from "./access-rules";

/** Live package entitlement for a user covering a given content item (directly or via a collection). */
export async function userHasPackageForContent(q: Queryable, userId: string, contentId: string, now: Date): Promise<boolean> {
  const r = await q.query(
    `select 1
       from entitlements e
       join package_items pi on pi.package_id = e.package_id
       left join collection_items ci on ci.collection_id = pi.collection_id
      where e.user_id = $1
        and e.revoked_at is null
        and (e.expires_at is null or e.expires_at > $3)
        and (e.purchase_id is null or exists (select 1 from purchases p where p.id = e.purchase_id and p.status = 'paid'))
        and (pi.content_id = $2 or ci.content_id = $2)
      limit 1`,
    [userId, contentId, now],
  );
  return r.rowCount > 0;
}

export async function userHasPackage(q: Queryable, userId: string, packageId: string, now: Date): Promise<boolean> {
  const r = await q.query(
    `select 1 from entitlements e
      where e.user_id = $1 and e.package_id = $2 and e.revoked_at is null
        and (e.expires_at is null or e.expires_at > $3)
        and (e.purchase_id is null or exists (select 1 from purchases p where p.id = e.purchase_id and p.status = 'paid'))
      limit 1`,
    [userId, packageId, now],
  );
  return r.rowCount > 0;
}

export async function loadSubscriptions(q: Queryable, userId: string): Promise<SubscriptionFact[]> {
  const r = await q.query(
    `select s.status, s.current_period_end, p.creator_id as plan_creator_id
       from subscriptions s join membership_plans p on p.id = s.plan_id
      where s.user_id = $1 and s.status in ('active','canceled')`,
    [userId],
  );
  return r.rows.map((x) => ({
    status: x.status,
    currentPeriodEnd: x.current_period_end ? new Date(x.current_period_end) : null,
    planCreatorId: x.plan_creator_id,
  }));
}

export type ContentRecord = {
  id: string; creator_id: string; title: string; description: string; kind: "photo" | "video";
  access_level: Tier; status: string; storage_key: string; thumbnail_key: string | null; mime_type: string;
  size_bytes: number; published_at: Date | null; creator_status: string; creator_name: string; creator_slug: string;
};

export async function loadContent(q: Queryable, id: string): Promise<ContentRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await q.query<ContentRecord>(
    `select c.*, cr.status as creator_status, cr.display_name as creator_name, cr.slug as creator_slug
       from content_items c join creators cr on cr.id = c.creator_id where c.id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/**
 * THE single server-side gate for protected content. Every route that reveals content bytes or
 * signed URLs (page render, media endpoint) must go through this.
 */
export async function checkContentAccess(viewer: Viewer, content: ContentRecord, now = new Date()): Promise<AccessDecision> {
  const db = await getDb();
  const grants: Grants = { hasPackage: false, subscriptions: [] };
  const needsGrants = viewer && viewer.status === "active" && viewer.emailVerified &&
    content.status === "published" && content.access_level !== "public" && content.access_level !== "free";
  if (needsGrants && viewer) {
    if (content.access_level === "package") grants.hasPackage = await userHasPackageForContent(db, viewer.id, content.id, now);
    if (content.access_level === "subscription") grants.subscriptions = await loadSubscriptions(db, viewer.id);
  }
  return evaluateAccess(
    viewer,
    {
      tier: content.access_level,
      creatorId: content.creator_id,
      published: content.status === "published",
      creatorApproved: content.creator_status === "approved",
    },
    grants,
    now,
  );
}

export type StreamRecord = {
  id: string; creator_id: string; title: string; description: string; access: "public" | "subscriber" | "purchase";
  package_id: string | null; status: string; scheduled_at: Date; provider: string | null; provider_ref: string | null;
  creator_status: string; creator_name: string;
};

/** Entitlement check for a livestream (status/provider availability is checked separately). */
export async function checkStreamAccess(viewer: Viewer, s: StreamRecord, now = new Date()): Promise<AccessDecision> {
  const db = await getDb();
  const tier: Tier = s.access === "public" ? "public" : s.access === "subscriber" ? "subscription" : "package";
  const grants: Grants = { hasPackage: false, subscriptions: [] };
  if (viewer && viewer.status === "active" && viewer.emailVerified) {
    if (tier === "package" && s.package_id) grants.hasPackage = await userHasPackage(db, viewer.id, s.package_id, now);
    if (tier === "subscription") grants.subscriptions = await loadSubscriptions(db, viewer.id);
  }
  return evaluateAccess(
    viewer,
    { tier, creatorId: s.creator_id, published: s.status !== "cancelled", creatorApproved: s.creator_status === "approved" },
    grants,
    now,
  );
}
