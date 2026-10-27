import type { Role, UserStatus } from "./permissions";

export type Viewer = {
  id: string;
  role: Role;
  status: UserStatus;
  emailVerified: boolean;
} | null;

export type Tier = "public" | "free" | "package" | "subscription";

export type SubscriptionFact = {
  status: string;
  currentPeriodEnd: Date | null;
  /** null = plan covers every creator */
  planCreatorId: string | null;
};

export type Grants = {
  /** user holds a live, non-refunded entitlement to a package that includes the item */
  hasPackage: boolean;
  subscriptions: SubscriptionFact[];
};

export type DenyReason =
  | "not_published"
  | "creator_unavailable"
  | "login_required"
  | "account_suspended"
  | "email_unverified"
  | "purchase_required"
  | "subscription_required";

export type AccessDecision =
  | { allowed: true; reason: "public" | "free" | "package" | "subscription" | "staff" }
  | { allowed: false; reason: DenyReason };

/**
 * A subscription grants access only while the paid period is still running.
 * 'active' => paid through current_period_end. 'canceled' => user cancelled but keeps access until period end.
 * 'past_due' | 'expired' | 'revoked' | 'pending' => never grant access.
 * Expiry is computed from time, so access ends correctly even if no background job has run.
 */
export function isSubscriptionLive(s: SubscriptionFact, now: Date): boolean {
  return (s.status === "active" || s.status === "canceled") && !!s.currentPeriodEnd && s.currentPeriodEnd.getTime() > now.getTime();
}

export function subscriptionCovers(s: SubscriptionFact, creatorId: string, now: Date): boolean {
  return isSubscriptionLive(s, now) && (s.planCreatorId === null || s.planCreatorId === creatorId);
}

export type Resource = {
  tier: Tier;
  creatorId: string;
  published: boolean;
  creatorApproved: boolean;
};

export function evaluateAccess(viewer: Viewer, res: Resource, grants: Grants, now = new Date()): AccessDecision {
  if (viewer && viewer.status === "active" && (viewer.role === "admin" || viewer.role === "moderator")) {
    return { allowed: true, reason: "staff" }; // staff may preview anything for moderation
  }
  if (!res.published) return { allowed: false, reason: "not_published" };
  if (!res.creatorApproved) return { allowed: false, reason: "creator_unavailable" };
  if (res.tier === "public") return { allowed: true, reason: "public" };

  if (!viewer) return { allowed: false, reason: "login_required" };
  if (viewer.status !== "active") return { allowed: false, reason: "account_suspended" };
  if (!viewer.emailVerified) return { allowed: false, reason: "email_unverified" };

  switch (res.tier) {
    case "free":
      return { allowed: true, reason: "free" };
    case "package":
      return grants.hasPackage ? { allowed: true, reason: "package" } : { allowed: false, reason: "purchase_required" };
    case "subscription":
      return grants.subscriptions.some((s) => subscriptionCovers(s, res.creatorId, now))
        ? { allowed: true, reason: "subscription" }
        : { allowed: false, reason: "subscription_required" };
  }
}
