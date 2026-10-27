import { beforeAll, describe, expect, it } from "vitest";
import { freshDb, mkUser } from "./helpers";
import { q, q1 } from "../src/lib/db";
import { authenticate, deleteAccount, exportUserData, registerUser, requestPasswordReset, resetPassword, verifyEmail, UserError } from "../src/lib/users";
import { readOutbox } from "../src/lib/email";
import { signToken, verifyToken, hashPassword, verifyPassword } from "../src/lib/crypto";
import { rateLimit } from "../src/lib/rate-limit";
import { can } from "../src/lib/permissions";
import { sniffMedia } from "../src/lib/storage";
import { buyPackage, mkContent, mkCreator, mkPackage } from "./helpers";

beforeAll(async () => { await freshDb(); });

const lastLink = (to: string) => readOutbox(200).find((m) => m.to === to)!.text.match(/https?:\/\/\S+token=(\S+)/)![1];

describe("registration / verification / reset", () => {
  it("requires adult + terms confirmation and a strong password", async () => {
    const base = { email: "a@x.example", password: "longenoughpassword" };
    await expect(registerUser({ ...base, adult: false, terms: true })).rejects.toThrow();
    await expect(registerUser({ ...base, adult: true, terms: false })).rejects.toThrow();
    await expect(registerUser({ ...base, password: "short", adult: true, terms: true })).rejects.toThrow();
  });

  it("full lifecycle: register → verify (one-time) → login → reset invalidates sessions", async () => {
    const email = `life${Date.now()}@x.example`;
    const { id } = await registerUser({ email: email.toUpperCase(), password: "first password 1", adult: true, terms: true });
    const u0 = await q1(`select email, email_verified_at, adult_confirmed_at from users where id=$1`, [id]);
    expect(u0!.email).toBe(email); // normalized
    expect(u0!.email_verified_at).toBeNull();
    expect(u0!.adult_confirmed_at).toBeTruthy();
    expect((await q(`select kind from consent_records where user_id=$1`, [id])).length).toBe(3);
    // raw password is never stored
    expect((await q1(`select password_hash from users where id=$1`, [id]))!.password_hash).not.toContain("first password");

    const tok = lastLink(email);
    expect(await verifyEmail("garbage")).toBe(false);
    expect(await verifyEmail(tok)).toBe(true);
    expect(await verifyEmail(tok)).toBe(false); // single use
    expect((await q1(`select email_verified_at from users where id=$1`, [id]))!.email_verified_at).toBeTruthy();

    expect(await authenticate(email, "wrong password!!")).toBeNull();
    expect((await authenticate(email, "first password 1"))!.id).toBe(id);
    expect(await authenticate("nobody@x.example", "whatever1234")).toBeNull();

    await q(`insert into sessions (user_id, token_hash, expires_at) values ($1,'s'||gen_random_uuid(), now()+interval '1 day')`, [id]);
    await requestPasswordReset(email);
    const rt = lastLink(email);
    expect(await resetPassword(rt, "second password 2")).toBe(true);
    expect(await resetPassword(rt, "third password 3")).toBe(false); // single use
    expect((await q(`select 1 from sessions where user_id=$1`, [id])).length).toBe(0);
    expect(await authenticate(email, "first password 1")).toBeNull();
    expect(await authenticate(email, "second password 2")).toBeTruthy();
  });

  it("expired tokens are rejected", async () => {
    const u = await mkUser({ verified: false });
    const tok = lastLink(u.email);
    await q(`update email_tokens set expires_at = now() - interval '1 minute' where user_id=$1`, [u.id]);
    expect(await verifyEmail(tok)).toBe(false);
  });

  it("duplicate registration is a generic failure and password-reset for unknown email sends nothing", async () => {
    const u = await mkUser();
    await expect(registerUser({ email: u.email, password: "another password", adult: true, terms: true })).rejects.toBeInstanceOf(UserError);
    const before = readOutbox(500).length;
    await requestPasswordReset("ghost@x.example");
    expect(readOutbox(500).length).toBe(before);
  });
});

describe("account deletion & export", () => {
  it("anonymizes the account, ends sessions, keeps financial records detached from PII", async () => {
    const u = await mkUser();
    const c = await mkCreator();
    await buyPackage(u.id, await mkPackage([await mkContent(c.id, "package")]));
    await q(`insert into sessions (user_id, token_hash, expires_at) values ($1,'d'||gen_random_uuid(), now()+interval '1 day')`, [u.id]);
    expect(await deleteAccount(u.id, "wrong password")).toBe(false);
    expect(await deleteAccount(u.id, "correct horse battery")).toBe(true);
    const row = await q1(`select email, status, display_name from users where id=$1`, [u.id]);
    expect(row!.status).toBe("deleted");
    expect(row!.email).toMatch(/^deleted-.*@deleted\.invalid$/);
    expect((await q(`select 1 from sessions where user_id=$1`, [u.id])).length).toBe(0);
    expect((await q(`select 1 from purchases where user_id=$1`, [u.id])).length).toBe(1);
    expect(await authenticate(u.email, "correct horse battery")).toBeNull();
  });

  it("the last active admin cannot be deleted", async () => {
    await q(`update users set role='member' where role='admin'`);
    const only = await mkUser({ role: "admin" });
    await expect(deleteAccount(only.id, "correct horse battery")).rejects.toThrow(/last administrator/);
  });

  it("export contains the user's own data only", async () => {
    const a = await mkUser(), b = await mkUser();
    const dump = await exportUserData(a.id);
    expect(JSON.stringify(dump)).toContain(a.email);
    expect(JSON.stringify(dump)).not.toContain(b.email);
    expect(JSON.stringify(dump)).not.toContain("password");
  });
});

describe("security primitives", () => {
  it("hashes passwords with scrypt and verifies", () => {
    const h = hashPassword("pw-123456789");
    expect(verifyPassword("pw-123456789", h)).toBe(true);
    expect(verifyPassword("pw-1234567890", h)).toBe(false);
  });
  it("signed tokens expire and cannot be tampered with", () => {
    const t = signToken({ c: "abc" }, 60, 1_000_000);
    expect(verifyToken(t, 1_000_000 + 59_000)).toMatchObject({ c: "abc" });
    expect(verifyToken(t, 1_000_000 + 61_000)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ c: "other", exp: 9999999999 })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, 1_000_000)).toBeNull();
    expect(verifyToken(`${body}.AAAA`, 1_000_000)).toBeNull();
    expect(verifyToken("nonsense", 1_000_000)).toBeNull();
  });
  it("rate limiter blocks after the limit and recovers after the window", () => {
    const k = `t-${Math.random()}`;
    expect([1, 2, 3].map(() => rateLimit(k, 3, 1000, 0).ok)).toEqual([true, true, true]);
    expect(rateLimit(k, 3, 1000, 10).ok).toBe(false);
    expect(rateLimit(k, 3, 1000, 1500).ok).toBe(true);
  });
  it("RBAC: members never get admin permissions; moderators are limited; suspended staff get nothing", () => {
    expect(can("member", "active", "admin.access")).toBe(false);
    expect(can(undefined, undefined, "admin.access")).toBe(false);
    expect(can("moderator", "active", "reports.manage")).toBe(true);
    expect(can("moderator", "active", "products.manage")).toBe(false);
    expect(can("moderator", "active", "users.manage")).toBe(false);
    expect(can("admin", "active", "products.manage")).toBe(true);
    expect(can("admin", "suspended", "products.manage")).toBe(false);
  });
  it("upload sniffing accepts real media and rejects disguised files", () => {
    expect(sniffMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mime).toBe("image/jpeg");
    expect(sniffMedia(Buffer.from("<svg onload=alert(1)></svg>"))).toBeNull();
    expect(sniffMedia(Buffer.from("#!/bin/sh\nrm -rf /"))).toBeNull();
    expect(sniffMedia(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(8)]))?.mime).toBe("video/mp4");
  });
});
