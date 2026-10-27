/** Privacy-conscious structured logging: no emails, passwords, tokens, or payment data. */
const SENSITIVE = /(pass|token|secret|authorization|cookie|email|card|key)/i;

function scrub(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return meta;
  return Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, SENSITIVE.test(k) ? "[redacted]" : v]));
}

function emit(level: string, msg: string, meta?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test") return;
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...scrub(meta) }));
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};

/** For the rare cases an identifier must appear in logs. */
export const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");
