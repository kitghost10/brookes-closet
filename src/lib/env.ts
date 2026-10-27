/** Central, lazy environment access. Secrets only ever come from process.env. */
const isProd = () => process.env.NODE_ENV === "production";

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const env = {
  get isProd() { return isProd(); },
  get appUrl() { return process.env.APP_URL || "http://localhost:3000"; },
  get appSecret(): string {
    const s = process.env.APP_SECRET;
    if (s && s.length >= 32) return s;
    if (isProd()) throw new Error("APP_SECRET must be set (>= 32 chars) in production");
    return "dev-only-insecure-secret-do-not-use-in-production";
  },
  get databaseUrl() { return process.env.DATABASE_URL || ""; },
  get storageDriver() { return process.env.STORAGE_DRIVER || "local"; },
  get storageLocalDir() { return process.env.STORAGE_LOCAL_DIR || ".data/private-media"; },
  get mediaUrlTtl() { return int("MEDIA_URL_TTL_SECONDS", 300); },
  get maxUploadBytes() { return int("MAX_UPLOAD_MB", 200) * 1024 * 1024; },
  get emailDriver() { return process.env.EMAIL_DRIVER || "console"; },
  get emailFrom() { return process.env.EMAIL_FROM || "Brooke's Closet <no-reply@example.com>"; },
  get paymentsProvider() { return process.env.PAYMENTS_PROVIDER || "dev_simulation"; },
  get streamProvider() { return process.env.STREAM_PROVIDER || "none"; },
  get termsVersion() { return process.env.TERMS_VERSION || "2026-10-draft"; },
  get sessionTtlDays() { return int("SESSION_TTL_DAYS", 14); },
  get retentionAuditDays() { return int("RETENTION_AUDIT_DAYS", 730); },
  get retentionReportDays() { return int("RETENTION_REPORT_DAYS", 1095); },
  get trustProxy() { return process.env.TRUST_PROXY_HEADERS === "true"; },
};
