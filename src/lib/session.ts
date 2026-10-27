import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb, q1 } from "./db";
import { randomToken, sha256 } from "./crypto";
import { env } from "./env";
import { can, type Permission } from "./permissions";
import type { Viewer } from "./access-rules";
import type { AuthUser } from "./users";

const COOKIE = "bc_session";

export async function createSession(userId: string) {
  const token = randomToken();
  const ua = (await headers()).get("user-agent")?.slice(0, 200) ?? null;
  const db = await getDb();
  await db.query(
    `insert into sessions (user_id, token_hash, expires_at, user_agent) values ($1,$2, now() + ($3 || ' days')::interval, $4)`,
    [userId, sha256(token), String(env.sessionTtlDays), ua],
  );
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: env.sessionTtlDays * 86400,
  });
}

export async function destroySession() {
  const c = await cookies();
  const token = c.get(COOKIE)?.value;
  if (token) (await getDb()).query(`delete from sessions where token_hash = $1`, [sha256(token)]);
  c.delete(COOKIE);
}

/** Resolves the session cookie to a user row (null if absent/expired/deleted). Cached per request. */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  return q1<AuthUser>(
    `select u.id, u.email, u.role, u.status, u.display_name, u.email_verified_at
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and u.status <> 'deleted'`,
    [sha256(token)],
  );
});

export const toViewer = (u: AuthUser | null): Viewer =>
  u ? { id: u.id, role: u.role, status: u.status, emailVerified: !!u.email_verified_at } : null;

export async function getViewer(): Promise<Viewer> {
  return toViewer(await getCurrentUser());
}

/** Page/action guard: signed-in, not suspended. */
export async function requireUser(returnTo?: string): Promise<AuthUser> {
  const u = await getCurrentUser();
  if (!u) redirect(`/login${returnTo ? `?next=${encodeURIComponent(returnTo)}` : ""}`);
  if (u.status === "suspended") redirect("/suspended");
  return u;
}

/** Page/action guard for admin features. Always call inside every admin page AND every admin action. */
export async function requirePermission(permission: Permission): Promise<AuthUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login?next=/admin");
  if (!can(u.role, u.status, permission)) redirect("/?e=Not+authorized");
  return u;
}

/** Best-effort client identifier for rate limiting. Proxy headers are only trusted if TRUST_PROXY_HEADERS=true. */
export async function clientKey(): Promise<string> {
  const h = await headers();
  if (env.trustProxy) {
    const xf = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (xf) return xf;
  }
  return h.get("x-real-ip") ?? "local";
}
