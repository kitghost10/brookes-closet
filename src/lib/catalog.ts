import { getDb, q, q1 } from "./db";
import { audit } from "./audit";
import { getStorage } from "./storage";

export class CatalogError extends Error {}

function pgToCatalogError(e: any): never {
  if (e?.code === "23514" || /cannot be (approved|published)|check constraint|violates check/i.test(String(e?.message))) {
    throw new CatalogError(String(e.message).replace(/^.*?error:\s*/i, ""));
  }
  if (e?.code === "23505") throw new CatalogError("That value is already in use");
  throw e;
}

export type VerificationDecision = {
  creatorId: string;
  reviewerId: string;
  decision: "approve" | "reject";
  ageVerified: boolean;
  consentOnFile: boolean;
  consentSignedAt: Date | null;
  documentRef: string | null;
  notes: string | null;
};

/** Admin verification workflow. A creator becomes 'approved' only through an approved verification. */
export async function reviewCreatorVerification(v: VerificationDecision): Promise<void> {
  const db = await getDb();
  try {
    await db.tx(async (t) => {
      if (v.decision === "approve") {
        await t.query(
          `insert into creator_verifications (creator_id, status, age_verified, consent_on_file, consent_signed_at, document_ref, notes, reviewed_by, reviewed_at)
           values ($1,'approved',$2,$3,$4,$5,$6,$7, now())`,
          [v.creatorId, v.ageVerified, v.consentOnFile, v.consentSignedAt, v.documentRef, v.notes, v.reviewerId]);
        await t.query(`update creators set status='approved', updated_at=now() where id=$1`, [v.creatorId]);
      } else {
        await t.query(
          `insert into creator_verifications (creator_id, status, age_verified, consent_on_file, document_ref, notes, reviewed_by, reviewed_at)
           values ($1,'rejected',$2,$3,$4,$5,$6, now())`,
          [v.creatorId, v.ageVerified, v.consentOnFile, v.documentRef, v.notes, v.reviewerId]);
        await t.query(`update creators set status='rejected', updated_at=now() where id=$1`, [v.creatorId]);
        // A rejected creator can't have live content.
        await t.query(`update content_items set status='unpublished', updated_at=now() where creator_id=$1 and status='published'`, [v.creatorId]);
      }
      await audit(v.reviewerId, `creator.verification_${v.decision}d`, "creator", v.creatorId, { age: v.ageVerified, consent: v.consentOnFile }, t);
    });
  } catch (e) { pgToCatalogError(e); }
}

export async function setCreatorStatus(creatorId: string, status: "pending_review" | "suspended" | "draft", actorId: string) {
  const db = await getDb();
  await db.tx(async (t) => {
    await t.query(`update creators set status=$2, updated_at=now() where id=$1`, [creatorId, status]);
    await audit(actorId, `creator.${status}`, "creator", creatorId, {}, t);
  });
}

export async function setContentStatus(contentId: string, status: "draft" | "published" | "unpublished" | "removed", actorId: string) {
  const db = await getDb();
  try {
    await db.tx(async (t) => {
      await t.query(
        `update content_items set status=$2, updated_at=now(),
                published_at = case when $2 = 'published' then coalesce(published_at, now()) else published_at end
          where id=$1`, [contentId, status]);
      await audit(actorId, `content.${status}`, "content", contentId, {}, t);
    });
  } catch (e) { pgToCatalogError(e); }
}

/** Permanently delete a content item and its stored objects. */
export async function deleteContent(contentId: string, actorId: string) {
  const row = await q1<{ storage_key: string; thumbnail_key: string | null }>(`select storage_key, thumbnail_key from content_items where id=$1`, [contentId]);
  if (!row) return;
  const db = await getDb();
  await db.tx(async (t) => {
    await t.query(`delete from content_items where id=$1`, [contentId]);
    await audit(actorId, "content.deleted", "content", contentId, {}, t);
  });
  const st = getStorage();
  await st.delete(row.storage_key);
  if (row.thumbnail_key) await st.delete(row.thumbnail_key);
}

export const REPORT_REASONS = ["non_consensual", "underage_concern", "copyright", "impersonation", "illegal", "other"] as const;

export async function createReport(input: {
  contentId: string | null; kind: "report" | "takedown"; reason: (typeof REPORT_REASONS)[number];
  details: string; reporterUserId: string | null; reporterEmail: string | null;
}) {
  let creatorId: string | null = null;
  if (input.contentId) {
    const c = await q1<{ creator_id: string }>(`select creator_id from content_items where id=$1`, [input.contentId]);
    if (!c) throw new CatalogError("Content not found");
    creatorId = c.creator_id;
  }
  const row = await q1<{ id: string }>(
    `insert into reports (content_id, creator_id, reporter_user_id, reporter_email, kind, reason, details)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [input.contentId, creatorId, input.reporterUserId, input.reporterEmail, input.kind, input.reason, input.details]);
  // Safety-critical reasons: auto-unpublish pending review so potentially harmful content stops being served immediately.
  if (input.contentId && ["non_consensual", "underage_concern"].includes(input.reason)) {
    await q(`update content_items set status='unpublished', updated_at=now() where id=$1 and status='published'`, [input.contentId]);
    await audit(null, "content.auto_unpublished_on_report", "content", input.contentId, { reportId: row!.id, reason: input.reason });
  }
  return row!.id;
}

export async function resolveReport(reportId: string, actorId: string, action: "dismiss" | "unpublish_content" | "remove_content" | "suspend_creator" | "note", note: string) {
  const db = await getDb();
  await db.tx(async (t) => {
    const r = (await t.query<any>(`select * from reports where id=$1 for update`, [reportId])).rows[0];
    if (!r) throw new CatalogError("Report not found");
    if (action === "unpublish_content" && r.content_id) await t.query(`update content_items set status='unpublished', updated_at=now() where id=$1`, [r.content_id]);
    if (action === "remove_content" && r.content_id) await t.query(`update content_items set status='removed', updated_at=now() where id=$1`, [r.content_id]);
    if (action === "suspend_creator" && r.creator_id) await t.query(`update creators set status='suspended', updated_at=now() where id=$1`, [r.creator_id]);
    await t.query(
      `insert into moderation_actions (report_id, content_id, creator_id, actor_id, action, note) values ($1,$2,$3,$4,$5,$6)`,
      [reportId, r.content_id, r.creator_id, actorId, action, note]);
    const status = action === "note" ? "reviewing" : action === "dismiss" ? "dismissed" : "actioned";
    await t.query(
      `update reports set status=$2, resolved_at = case when $2 in ('actioned','dismissed') then now() else null end,
              resolved_by = case when $2 in ('actioned','dismissed') then $3::uuid else null end where id=$1`,
      [reportId, status, actorId]);
    await audit(actorId, `report.${action}`, "report", reportId, {}, t);
  });
}
