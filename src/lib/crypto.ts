import crypto from "node:crypto";
import { env } from "./env";

const N = 16384, R = 8, P = 1, KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: +n, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

/** Used to equalize timing when the account doesn't exist. */
export const DUMMY_HASH = hashPassword("dummy-password-for-timing");

export const randomToken = () => crypto.randomBytes(32).toString("base64url");
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (data: string) => crypto.createHmac("sha256", env.appSecret).update(data).digest("base64url");

/** HMAC-signed, expiring token: `<payload>.<sig>` */
export function signToken(payload: Record<string, unknown>, ttlSeconds: number, now = Date.now()): string {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }));
  return `${body}.${mac(body)}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string, now = Date.now()): (T & { exp: number }) | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = mac(body);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof data.exp !== "number" || data.exp * 1000 < now) return null;
    return data;
  } catch { return null; }
}
