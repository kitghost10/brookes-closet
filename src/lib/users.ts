import { z } from "zod";
import { getDb, q, q1 } from "./db";
import { DUMMY_HASH, hashPassword, randomToken, sha256, verifyPassword } from "./crypto";
import { env } from "./env";
import { sendEmail } from "./email";
import { audit } from "./audit";

export const passwordSchema = z.string().min(10, "Password must be at least 10 characters").max(128);
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(60).optional(),
  adult: z.literal(true, { error: "You must confirm you are an adult (18+ or the age of majority where you live)" }),
  terms: z.literal(true, { error: "You must accept the Terms and Privacy Policy" }),
});

export class UserError extends Error {}

const VERIFY_TTL_H = 24, RESET_TTL_H = 1;

async function issueToken(userId: string, kind: "verify_email" | "reset_password", hours: number): Promise<string> {
  const token = randomToken();
  await q(
    `insert into email_tokens (user_id, kind, token_hash, expires_at) values ($1,$2,$3, now() + ($4 || ' hours')::interval)`,
    [userId, kind, sha256(token), String(hours)],
  );
  return token;
}

export async function sendVerificationEmail(userId: string, email: string) {
  const token = await issueToken(userId, "verify_email", VERIFY_TTL_H);
  await sendEmail({
    to: email,
    subject: "Verify your email — Brooke's Closet",
    text: `Confirm your email address:\n${env.appUrl}/verify-email?token=${token}\n\nThis link expires in ${VERIFY_TTL_H} hours.`,
  });
}

export async function registerUser(input: unknown): Promise<{ id: string }> {
  const d = registerSchema.parse(input);
  const db = await getDb();
  let id: string;
  try {
    id = await db.tx(async (t) => {
      const r = await t.query<{ id: string }>(
        `insert into users (email, password_hash, display_name, adult_confirmed_at, terms_accepted_at, terms_version)
         values ($1,$2,$3, now(), now(), $4) returning id`,
        [d.email, hashPassword(d.password), d.displayName || null, env.termsVersion],
      );
      const uid = r.rows[0].id;
      for (const kind of ["adult_confirmation", "terms", "privacy"]) {
        await t.query(`insert into consent_records (user_id, kind, version) values ($1,$2,$3)`, [uid, kind, env.termsVersion]);
      }
      return uid;
    });
  } catch (e: any) {
    if (e?.code === "23505" || /users_email_key|duplicate key/.test(String(e?.message))) {
      // Do not reveal whether the email exists. Caller shows the same message either way.
      throw new UserError("exists");
    }
    throw e;
  }
  await sendVerificationEmail(id, d.email);
  return { id };
}

export async function verifyEmail(token: string): Promise<boolean> {
  const db = await getDb();
  return db.tx(async (t) => {
    const r = await t.query<{ id: string; user_id: string }>(
      `update email_tokens set used_at = now()
        where token_hash = $1 and kind = 'verify_email' and used_at is null and expires_at > now()
        returning id, user_id`,
      [sha256(token)],
    );
    if (!r.rows[0]) return false;
    await t.query(`update users set email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = $1`, [r.rows[0].user_id]);
    return true;
  });
}

export type AuthUser = { id: string; email: string; role: "member" | "moderator" | "admin"; status: "active" | "suspended" | "deleted"; display_name: string | null; email_verified_at: Date | null };

export async function authenticate(emailRaw: string, password: string): Promise<AuthUser | null> {
  const email = emailSchema.safeParse(emailRaw);
  const row = email.success
    ? await q1<AuthUser & { password_hash: string }>(`select * from users where email = $1 and status <> 'deleted'`, [email.data])
    : null;
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH); // constant-ish time
  if (!row || !ok) return null;
  return row;
}

export async function requestPasswordReset(emailRaw: string): Promise<void> {
  const email = emailSchema.safeParse(emailRaw);
  if (!email.success) return;
  const u = await q1<{ id: string }>(`select id from users where email = $1 and status = 'active'`, [email.data]);
  if (!u) return; // silent: no account enumeration
  const token = await issueToken(u.id, "reset_password", RESET_TTL_H);
  await sendEmail({
    to: email.data,
    subject: "Reset your password — Brooke's Closet",
    text: `Reset your password:\n${env.appUrl}/reset-password?token=${token}\n\nThis link expires in ${RESET_TTL_H} hour. If you didn't request it, ignore this email.`,
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  const pw = passwordSchema.parse(newPassword);
  const db = await getDb();
  return db.tx(async (t) => {
    const r = await t.query<{ user_id: string }>(
      `update email_tokens set used_at = now()
        where token_hash = $1 and kind = 'reset_password' and used_at is null and expires_at > now()
        returning user_id`,
      [sha256(token)],
    );
    if (!r.rows[0]) return false;
    const uid = r.rows[0].user_id;
    await t.query(`update users set password_hash = $2, updated_at = now() where id = $1`, [uid, hashPassword(pw)]);
    await t.query(`delete from sessions where user_id = $1`, [uid]); // sign out everywhere
    return true;
  });
}

export async function changePassword(userId: string, current: string, next: string): Promise<boolean> {
  const pw = passwordSchema.parse(next);
  const u = await q1<{ password_hash: string }>(`select password_hash from users where id = $1`, [userId]);
  if (!u || !verifyPassword(current, u.password_hash)) return false;
  await q(`update users set password_hash = $2, updated_at = now() where id = $1`, [userId, hashPassword(pw)]);
  return true;
}

/**
 * Account deletion: anonymizes the user immediately, ends sessions and recurring billing.
 * Purchase/billing rows are retained (tax / dispute records) but detached from any personal data.
 */
export async function deleteAccount(userId: string, password: string, actorId: string | null = null): Promise<boolean> {
  const u = await q1<{ password_hash: string; role: string }>(`select password_hash, role from users where id = $1 and status <> 'deleted'`, [userId]);
  if (!u) return false;
  if (actorId === null && !verifyPassword(password, u.password_hash)) return false;
  if (u.role === "admin") {
    const others = await q1<{ n: number }>(`select count(*)::int n from users where role='admin' and status='active' and id <> $1`, [userId]);
    if (!others || others.n === 0) throw new UserError("Cannot delete the last administrator");
  }
  const db = await getDb();
  await db.tx(async (t) => {
    await t.query(`delete from sessions where user_id = $1`, [userId]);
    await t.query(`delete from email_tokens where user_id = $1`, [userId]);
    await t.query(
      `update subscriptions set status = case when status in ('active','canceled') then 'canceled' else status end,
              cancel_at_period_end = true, canceled_at = coalesce(canceled_at, now()), updated_at = now()
        where user_id = $1`, [userId]);
    await t.query(
      `update users set email = 'deleted-' || id || '@deleted.invalid', password_hash = 'x', display_name = null,
              status = 'deleted', deleted_at = now(), updated_at = now(), role = 'member' where id = $1`, [userId]);
    await t.query(`update reports set reporter_email = null, reporter_user_id = null where reporter_user_id = $1`, [userId]);
    await audit(actorId ?? userId, "account.deleted", "user", userId, {}, t);
  });
  return true;
}

export async function exportUserData(userId: string) {
  const [user] = await q(`select id, email, display_name, role, status, email_verified_at, created_at, terms_version from users where id=$1`, [userId]);
  return {
    exported_at: new Date().toISOString(),
    user,
    consents: await q(`select kind, version, created_at from consent_records where user_id=$1 order by created_at`, [userId]),
    purchases: await q(`select id, package_id, amount_cents, currency, status, paid_at, refunded_at, created_at from purchases where user_id=$1`, [userId]),
    subscriptions: await q(`select id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at from subscriptions where user_id=$1`, [userId]),
    billing_events: await q(`select type, amount_cents, currency, description, created_at from billing_events where user_id=$1`, [userId]),
  };
}
