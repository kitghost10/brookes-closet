import fs from "node:fs";
import path from "node:path";
import { env } from "./env";
import { log } from "./log";

export type EmailMessage = { to: string; subject: string; text: string };

/**
 * Email adapter. Only the `console` driver exists (development: writes .data/outbox.jsonl,
 * viewable at /dev/outbox, disabled in production). A production transactional-email provider
 * adapter MUST be added here before launch — without it verification/reset emails cannot be delivered.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  if (env.emailDriver === "console") {
    if (env.isProd) throw new Error("EMAIL_DRIVER=console is not allowed in production; implement a real email adapter");
    const file = path.resolve(process.cwd(), ".data/outbox.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...msg }) + "\n");
    log.info("email.queued_dev_outbox", {});
    return;
  }
  throw new Error(`Unknown EMAIL_DRIVER "${env.emailDriver}"`);
}

export function readOutbox(limit = 50): (EmailMessage & { at: string })[] {
  const file = path.resolve(process.cwd(), ".data/outbox.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-limit).reverse().map((l) => JSON.parse(l));
}
