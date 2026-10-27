/**
 * Authorization primitives. Pure and framework-free so they are unit-tested.
 * Server code must call these; hiding UI is never a security control.
 */
export type Role = "member" | "moderator" | "admin";
export type UserStatus = "active" | "suspended" | "deleted";

export type Permission =
  | "admin.access"
  | "metrics.view"
  | "users.manage"
  | "creators.manage"
  | "creators.verify"
  | "content.manage"
  | "content.moderate"
  | "products.manage"
  | "sales.view"
  | "sales.manage"
  | "livestreams.manage"
  | "reports.manage"
  | "audit.view";

const MODERATOR: Permission[] = ["admin.access", "metrics.view", "content.moderate", "reports.manage"];

export function can(role: Role | undefined, status: UserStatus | undefined, permission: Permission): boolean {
  if (status !== "active") return false;
  if (role === "admin") return true; // admin holds every permission
  if (role === "moderator") return MODERATOR.includes(permission);
  return false;
}

export const isStaff = (role?: Role, status?: UserStatus) => status === "active" && (role === "admin" || role === "moderator");
