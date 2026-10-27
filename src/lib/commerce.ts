import { getDb, q, q1, type Queryable } from "./db";
import { audit } from "./audit";
import { getPaymentProvider } from "./payments";

export class CommerceError extends Error {}

const CHECKOUT_TTL_MIN = 30;

export async function startCheckout(userId: string, kind: "package" | "plan", itemId: string): Promise<string> {
  const user = await q1<{ status: string; email_verified_at: Date | null }>(`select status, email_verified_at from users where id=$1`, [userId]);
  if (!user || user.status !== "active") throw new CommerceError("Your account cannot make purchases");
  if (!user.email_verified_at) throw new CommerceError("Please verify your email before purchasing");

  let name: string, amount: number, currency: string;
  if (kind === "package") {
    const p = await q1<any>(`select * from packages where id=$1 and active`, [itemId]);
    if (!p) throw new CommerceError("This package is not available");
    const owned = await q1(`select 1 from entitlements where user_id=$1 and package_id=$2 and revoked_at is null`, [userId, itemId]);
    if (owned) throw new CommerceError("You already own this package");
    ({ name, price_cents: amount, currency } = p);
  } else {
    const p = await q1<any>(`select * from membership_plans where id=$1 and active`, [itemId]);
    if (!p) throw new CommerceError("This plan is not available");
    const live = await q1(`select 1 from subscriptions where user_id=$1 and plan_id=$2 and status in ('pending','active','past_due')`, [userId, itemId]);
    if (live) throw new CommerceError("You already have this subscription");
    ({ name, price_cents: amount, currency } = p);
  }

  const provider = getPaymentProvider();
  const session = await q1<{ id: string }>(
    `insert into checkout_sessions (user_id, kind, package_id, plan_id, amount_cents, currency, provider, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval) returning id`,
    [userId, kind, kind === "package" ? itemId : null, kind === "plan" ? itemId : null, amount, currency, provider.id, String(CHECKOUT_TTL_MIN)],
  );
  const { checkoutUrl, providerRef } = await provider.createCheckout({
    sessionId: session!.id, userId, kind, itemName: name, amountCents: amount, currency,
  });
  await q(`update checkout_sessions set provider_ref=$2 where id=$1`, [session!.id, providerRef]);
  return checkoutUrl;
}

/**
 * Idempotent fulfillment. Called by the dev simulator today and by a verified provider webhook later.
 * Never call this from a client-controlled path without verifying payment with the provider.
 */
export async function fulfillCheckout(sessionId: string, now = new Date()): Promise<{ kind: "package" | "plan"; id: string }> {
  const db = await getDb();
  return db.tx(async (t) => {
    const s = (await t.query<any>(`select * from checkout_sessions where id=$1 for update`, [sessionId])).rows[0];
    if (!s) throw new CommerceError("Checkout not found");
    if (s.status === "completed") {
      const existing = s.kind === "package"
        ? (await t.query(`select id from purchases where checkout_session_id=$1`, [sessionId])).rows[0]
        : (await t.query(`select id from subscriptions where checkout_session_id=$1`, [sessionId])).rows[0];
      return { kind: s.kind, id: existing.id };
    }
    if (s.status !== "open" || new Date(s.expires_at) < now) throw new CommerceError("Checkout expired or canceled");

    let id: string;
    if (s.kind === "package") {
      id = (await t.query<{ id: string }>(
        `insert into purchases (user_id, package_id, checkout_session_id, amount_cents, currency, status, provider, provider_ref, paid_at)
         values ($1,$2,$3,$4,$5,'paid',$6,$7,$8) returning id`,
        [s.user_id, s.package_id, s.id, s.amount_cents, s.currency, s.provider, s.provider_ref, now],
      )).rows[0].id;
      await t.query(
        `insert into entitlements (user_id, package_id, source, purchase_id) values ($1,$2,'purchase',$3)
         on conflict (user_id, package_id) where revoked_at is null do nothing`,
        [s.user_id, s.package_id, id],
      );
      await t.query(
        `insert into billing_events (user_id, type, amount_cents, currency, purchase_id, description)
         values ($1,'charge',$2,$3,$4,'One-time package purchase')`,
        [s.user_id, s.amount_cents, s.currency, id],
      );
    } else {
      id = (await t.query<{ id: string }>(
        `insert into subscriptions (user_id, plan_id, checkout_session_id, status, current_period_start, current_period_end, provider, provider_ref)
         values ($1,$2,$3,'active',$4, $4::timestamptz + interval '1 month', $5,$6) returning id`,
        [s.user_id, s.plan_id, s.id, now, s.provider, s.provider_ref],
      )).rows[0].id;
      await t.query(
        `insert into billing_events (user_id, type, amount_cents, currency, subscription_id, description)
         values ($1,'charge',$2,$3,$4,'Subscription started')`,
        [s.user_id, s.amount_cents, s.currency, id],
      );
    }
    await t.query(`update checkout_sessions set status='completed', completed_at=$2 where id=$1`, [sessionId, now]);
    return { kind: s.kind, id };
  });
}

export async function cancelCheckout(sessionId: string, userId: string) {
  await q(`update checkout_sessions set status='canceled' where id=$1 and user_id=$2 and status='open'`, [sessionId, userId]);
}

/** User-initiated cancel: stops renewal; access continues until the paid period ends. */
export async function cancelSubscription(userId: string, subscriptionId: string): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    const s = (await t.query<any>(
      `select s.*, p.price_cents, p.currency from subscriptions s join membership_plans p on p.id=s.plan_id
        where s.id=$1 and s.user_id=$2 and s.status='active' for update of s`, [subscriptionId, userId])).rows[0];
    if (!s) throw new CommerceError("Subscription not found or not active");
    await getPaymentProvider().cancelSubscription(s.provider_ref);
    await t.query(
      `update subscriptions set status='canceled', cancel_at_period_end=true, canceled_at=now(), updated_at=now() where id=$1`, [s.id]);
    await t.query(
      `insert into billing_events (user_id, type, subscription_id, currency, description)
       values ($1,'cancellation',$2,$3,'Subscription canceled; access continues until period end')`, [userId, s.id, s.currency]);
  });
}

/** Provider renewal webhook (and dev simulator): extend the paid period by one month. */
export async function renewSubscription(subscriptionId: string, now = new Date()): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    const s = (await t.query<any>(
      `select s.*, p.price_cents, p.currency from subscriptions s join membership_plans p on p.id=s.plan_id
        where s.id=$1 for update of s`, [subscriptionId])).rows[0];
    if (!s) throw new CommerceError("Subscription not found");
    if (s.status === "revoked") throw new CommerceError("Subscription was revoked");
    if (s.cancel_at_period_end) throw new CommerceError("Subscription is set to cancel");
    // Renew from the later of "now" and the previous period end (so a lapsed sub doesn't get free time).
    const base: Date = s.current_period_end && new Date(s.current_period_end) > now ? new Date(s.current_period_end) : now;
    await t.query(
      `update subscriptions set status='active', current_period_start=$2, current_period_end=$2::timestamptz + interval '1 month', updated_at=now() where id=$1`,
      [s.id, base]);
    await t.query(
      `insert into billing_events (user_id, type, amount_cents, currency, subscription_id, description)
       values ($1,'renewal',$2,$3,$4,'Subscription renewed')`, [s.user_id, s.price_cents, s.currency, s.id]);
  });
}

/** Sweeper: persist the 'expired' state for lapsed periods. Access never depends on it (time-checked at read). */
export async function expireLapsedSubscriptions(now = new Date()): Promise<number> {
  const r = await (await getDb()).query(
    `update subscriptions set status='expired', updated_at=now()
      where status in ('active','canceled') and current_period_end <= $1`, [now]);
  return r.rowCount;
}

export async function refundPurchase(purchaseId: string, actorId: string): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    const p = (await t.query<any>(`select * from purchases where id=$1 for update`, [purchaseId])).rows[0];
    if (!p) throw new CommerceError("Purchase not found");
    if (p.status !== "paid") throw new CommerceError("Only paid purchases can be refunded");
    await getPaymentProvider().refund(p.provider_ref, p.amount_cents);
    await t.query(`update purchases set status='refunded', refunded_at=now() where id=$1`, [p.id]);
    await t.query(`update entitlements set revoked_at=now(), revoked_reason='refunded' where purchase_id=$1 and revoked_at is null`, [p.id]);
    await t.query(
      `insert into billing_events (user_id, type, amount_cents, currency, purchase_id, description)
       values ($1,'refund',$2,$3,$4,'Purchase refunded; access revoked')`, [p.user_id, p.amount_cents, p.currency, p.id]);
    await audit(actorId, "purchase.refunded", "purchase", p.id, { amount_cents: p.amount_cents }, t);
  });
}

export async function revokeSubscription(subscriptionId: string, actorId: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    const s = (await t.query<any>(`select * from subscriptions where id=$1 for update`, [subscriptionId])).rows[0];
    if (!s) throw new CommerceError("Subscription not found");
    await t.query(`update subscriptions set status='revoked', cancel_at_period_end=true, canceled_at=now(), updated_at=now() where id=$1`, [s.id]);
    await t.query(
      `insert into billing_events (user_id, type, subscription_id, description) values ($1,'revocation',$2,$3)`,
      [s.user_id, s.id, `Access revoked by staff: ${reason}`.slice(0, 300)]);
    await audit(actorId, "subscription.revoked", "subscription", s.id, { reason }, t);
  });
}

export async function grantPackage(userId: string, packageId: string, actorId: string, expiresAt: Date | null): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    await t.query(
      `insert into entitlements (user_id, package_id, source, granted_by, expires_at) values ($1,$2,'admin_grant',$3,$4)
       on conflict (user_id, package_id) where revoked_at is null do update set expires_at = excluded.expires_at`,
      [userId, packageId, actorId, expiresAt]);
    await audit(actorId, "entitlement.granted", "user", userId, { packageId }, t);
  });
}

export async function revokeEntitlement(entitlementId: string, actorId: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    await t.query(`update entitlements set revoked_at=now(), revoked_reason=$2 where id=$1 and revoked_at is null`, [entitlementId, reason]);
    await audit(actorId, "entitlement.revoked", "entitlement", entitlementId, { reason }, t);
  });
}

export async function suspendUser(userId: string, actorId: string, suspend: boolean): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    if (userId === actorId) throw new CommerceError("You cannot suspend yourself");
    await t.query(`update users set status=$2, updated_at=now() where id=$1 and status <> 'deleted'`, [userId, suspend ? "suspended" : "active"]);
    if (suspend) await t.query(`delete from sessions where user_id=$1`, [userId]);
    await audit(actorId, suspend ? "user.suspended" : "user.reinstated", "user", userId, {}, t);
  });
}

export type { Queryable };
