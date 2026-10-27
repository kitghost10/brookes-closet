import { getDb, q } from "./db";
import { env } from "./env";

/**
 * Retention / maintenance. Run on a schedule (cron / platform scheduler): `npm run maintenance`.
 * - Expire lapsed subscriptions (state persistence only; access is time-checked at read).
 * - Purge expired sessions and used/expired email tokens.
 * - Purge old audit logs and resolved reports per configured retention.
 * Purchases and billing events are retained for financial/legal record keeping (see docs/OPERATIONS.md).
 */
export async function runMaintenance(now = new Date()) {
  const db = await getDb();
  const out: Record<string, number> = {};
  out.subscriptionsExpired = (await db.query(
    `update subscriptions set status='expired', updated_at=now() where status in ('active','canceled') and current_period_end <= $1`, [now])).rowCount;
  out.sessionsPurged = (await db.query(`delete from sessions where expires_at < $1`, [now])).rowCount;
  out.tokensPurged = (await db.query(
    `delete from email_tokens where expires_at < $1 or used_at < $1::timestamptz - interval '7 days'`, [now])).rowCount;
  out.checkoutsExpired = (await db.query(
    `update checkout_sessions set status='expired' where status='open' and expires_at < $1`, [now])).rowCount;
  out.reportsPurged = (await db.query(
    `delete from reports where status in ('actioned','dismissed') and resolved_at < $1::timestamptz - ($2 || ' days')::interval`,
    [now, String(env.retentionReportDays)])).rowCount;
  out.auditPurged = await db.tx(async (t) => {
    await t.query(`select set_config('app.allow_audit_purge','on', true)`);
    return (await t.query(`delete from audit_logs where created_at < $1::timestamptz - ($2 || ' days')::interval`, [now, String(env.retentionAuditDays)])).rowCount;
  });
  void q;
  return out;
}
