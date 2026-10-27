import { getDb, type Queryable } from "./db";
import { log } from "./log";

/** Append-only audit trail for admin/moderation actions. Never put secrets or raw PII in `metadata`. */
export async function audit(
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
  q?: Queryable,
): Promise<void> {
  const db = q ?? (await getDb());
  await db.query(
    `insert into audit_logs (actor_id, action, entity_type, entity_id, metadata) values ($1,$2,$3,$4,$5::jsonb)`,
    [actorId, action, entityType, entityId, JSON.stringify(metadata)],
  );
  log.info("audit", { action, entityType, entityId });
}
