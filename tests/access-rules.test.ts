import { describe, expect, it } from "vitest";
import { evaluateAccess, type Grants, type Resource, type Viewer } from "../src/lib/access-rules";

const NOW = new Date("2026-06-15T12:00:00Z");
const day = (d: number) => new Date(NOW.getTime() + d * 86400_000);
const none: Grants = { hasPackage: false, subscriptions: [] };
const res = (o: Partial<Resource> = {}): Resource => ({ tier: "package", creatorId: "c1", published: true, creatorApproved: true, ...o });
const member = (o: Partial<NonNullable<Viewer>> = {}): Viewer => ({ id: "u1", role: "member", status: "active", emailVerified: true, ...o });
const sub = (status: string, end: Date | null, planCreatorId: string | null = null) => ({ status, currentPeriodEnd: end, planCreatorId });

describe("evaluateAccess (pure rules)", () => {
  it("public content is open to anonymous visitors", () => {
    expect(evaluateAccess(null, res({ tier: "public" }), none, NOW)).toEqual({ allowed: true, reason: "public" });
  });
  it("free content needs a verified, active account", () => {
    const r = res({ tier: "free" });
    expect(evaluateAccess(null, r, none, NOW)).toEqual({ allowed: false, reason: "login_required" });
    expect(evaluateAccess(member({ emailVerified: false }), r, none, NOW)).toEqual({ allowed: false, reason: "email_unverified" });
    expect(evaluateAccess(member({ status: "suspended" }), r, none, NOW)).toEqual({ allowed: false, reason: "account_suspended" });
    expect(evaluateAccess(member(), r, none, NOW).allowed).toBe(true);
  });
  it("package content requires a package entitlement", () => {
    expect(evaluateAccess(member(), res(), none, NOW)).toEqual({ allowed: false, reason: "purchase_required" });
    expect(evaluateAccess(member(), res(), { ...none, hasPackage: true }, NOW).allowed).toBe(true);
  });
  it("a subscription does NOT unlock package-only content", () => {
    const g: Grants = { hasPackage: false, subscriptions: [sub("active", day(10))] };
    expect(evaluateAccess(member(), res({ tier: "package" }), g, NOW).allowed).toBe(false);
  });
  it("a package does NOT unlock subscription-only content", () => {
    expect(evaluateAccess(member(), res({ tier: "subscription" }), { ...none, hasPackage: true }, NOW).allowed).toBe(false);
  });

  describe("subscription expiry", () => {
    const r = res({ tier: "subscription" });
    const check = (s: ReturnType<typeof sub>) => evaluateAccess(member(), r, { ...none, subscriptions: [s] }, NOW).allowed;
    it("active within period => allowed", () => expect(check(sub("active", day(1)))).toBe(true));
    it("active but period ended => denied (no sweeper needed)", () => expect(check(sub("active", day(-1)))).toBe(false));
    it("period ends exactly now => denied", () => expect(check(sub("active", NOW))).toBe(false));
    it("canceled keeps access until period end", () => expect(check(sub("canceled", day(3)))).toBe(true));
    it("canceled after period end => denied", () => expect(check(sub("canceled", day(-3)))).toBe(false));
    it.each(["past_due", "expired", "revoked", "pending"])("%s => denied", (s) => expect(check(sub(s, day(30)))).toBe(false));
    it("missing period end => denied", () => expect(check(sub("active", null))).toBe(false));
    it("a creator-specific plan does not cover other creators", () => expect(check(sub("active", day(5), "other"))).toBe(false));
    it("a creator-specific plan covers its creator", () => expect(check(sub("active", day(5), "c1"))).toBe(true));
    it("an all-creator plan covers everyone", () => expect(check(sub("active", day(5), null))).toBe(true));
  });

  it("unpublished/removed content is denied even with entitlements", () => {
    expect(evaluateAccess(member(), res({ published: false }), { ...none, hasPackage: true }, NOW).reason).toBe("not_published");
    expect(evaluateAccess(null, res({ tier: "public", published: false }), none, NOW).allowed).toBe(false);
  });
  it("content of an unapproved/suspended creator is denied", () => {
    expect(evaluateAccess(member(), res({ tier: "free", creatorApproved: false }), none, NOW).reason).toBe("creator_unavailable");
    expect(evaluateAccess(null, res({ tier: "public", creatorApproved: false }), none, NOW).allowed).toBe(false);
  });
  it("suspended members keep nothing paid, even with live grants", () => {
    const g: Grants = { hasPackage: true, subscriptions: [sub("active", day(5))] };
    const v = member({ status: "suspended" });
    expect(evaluateAccess(v, res({ tier: "package" }), g, NOW).allowed).toBe(false);
    expect(evaluateAccess(v, res({ tier: "subscription" }), g, NOW).allowed).toBe(false);
  });
  it("staff can preview unpublished content; suspended staff cannot", () => {
    expect(evaluateAccess(member({ role: "moderator" }), res({ published: false }), none, NOW).allowed).toBe(true);
    expect(evaluateAccess(member({ role: "admin", status: "suspended" }), res({ published: false }), none, NOW).allowed).toBe(false);
  });
});
