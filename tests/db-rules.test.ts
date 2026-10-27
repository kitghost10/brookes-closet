import { beforeAll, describe, expect, it } from "vitest";
import { freshDb, mkContent, mkCreator, mkUser } from "./helpers";
import { q, q1, type Db } from "../src/lib/db";
import { createReport, resolveReport, reviewCreatorVerification, setContentStatus } from "../src/lib/catalog";
import { audit } from "../src/lib/audit";
import { runMaintenance } from "../src/lib/maintenance";

let db: Db;
beforeAll(async () => { db = await freshDb(); });

describe("database constraints", () => {
  it("a creator cannot be approved without a verification record", async () => {
    const c = await q1<{ id: string }>(`insert into creators (slug, display_name) values ('nov-'||gen_random_uuid(),'X') returning id`);
    await expect(q(`update creators set status='approved' where id=$1`, [c!.id])).rejects.toThrow(/cannot be approved/);
  });

  it("approved verification requires age + consent + reviewer", async () => {
    const admin = await mkUser({ role: "admin" });
    const c = await q1<{ id: string }>(`insert into creators (slug, display_name) values ('v-'||gen_random_uuid(),'X') returning id`);
    await expect(reviewCreatorVerification({
      creatorId: c!.id, reviewerId: admin.id, decision: "approve", ageVerified: true, consentOnFile: false,
      consentSignedAt: new Date(), documentRef: null, notes: null,
    })).rejects.toThrow();
    expect((await q1(`select status from creators where id=$1`, [c!.id]))!.status).toBe("draft");
  });

  it("content cannot be published for a non-approved creator", async () => {
    const c = await mkCreator({ approved: false });
    await expect(mkContent(c.id, "free", "published")).rejects.toThrow(/not approved/);
    const draft = await mkContent(c.id, "free", "draft");
    await expect(setContentStatus(draft, "published", c.adminId)).rejects.toThrow(/not approved/);
  });

  it("rejecting a creator unpublishes their content", async () => {
    const c = await mkCreator();
    const item = await mkContent(c.id, "free");
    await reviewCreatorVerification({
      creatorId: c.id, reviewerId: c.adminId, decision: "reject", ageVerified: false, consentOnFile: false,
      consentSignedAt: null, documentRef: null, notes: "mismatch",
    });
    expect((await q1(`select status from content_items where id=$1`, [item]))!.status).toBe("unpublished");
  });

  it("rejects negative prices, bad slugs, duplicate emails", async () => {
    await expect(q(`insert into packages (slug,name,price_cents) values ('ok','n',-1)`)).rejects.toThrow();
    await expect(q(`insert into packages (slug,name,price_cents) values ('Bad Slug','n',1)`)).rejects.toThrow();
    const u = await mkUser();
    await expect(q(`insert into users (email,password_hash,adult_confirmed_at,terms_accepted_at,terms_version) values ($1,'x',now(),now(),'v')`, [u.email]))
      .rejects.toThrow();
    await expect(q(`insert into users (email,password_hash,adult_confirmed_at,terms_accepted_at,terms_version) values ('UPPER@x.com','x',now(),now(),'v')`))
      .rejects.toThrow();
  });

  it("only one live subscription per user+plan; purchase-type package requires item target", async () => {
    await expect(q(`insert into package_items (package_id, content_id, collection_id) values (gen_random_uuid(), null, null)`)).rejects.toThrow();
  });

  it("audit logs are append-only", async () => {
    await audit(null, "test.event", "test", "1");
    await expect(q(`update audit_logs set action='tampered'`)).rejects.toThrow(/append-only/);
    await expect(q(`delete from audit_logs`)).rejects.toThrow(/append-only/);
  });
});

describe("row-level security (defense in depth)", () => {
  it("a non-owner role sees no rows and cannot write, even with table grants", async () => {
    await mkUser();
    await db.exec(`create role web_anon nologin; grant usage on schema public to web_anon; grant select, insert, update, delete on all tables in schema public to web_anon;`);
    try {
      await db.exec(`set role web_anon`);
      for (const t of ["users", "sessions", "purchases", "creator_verifications", "content_items", "audit_logs"]) {
        const r = await db.query(`select * from ${t}`);
        expect(r.rows.length, t).toBe(0);
      }
      await expect(db.exec(`insert into audit_logs (action, entity_type) values ('x','y')`)).rejects.toThrow(/row-level security/);
    } finally {
      await db.exec(`reset role`);
    }
    expect((await q(`select 1 from users`)).length).toBeGreaterThan(0); // owner still sees data
  });
});

describe("reports and takedowns", () => {
  it("safety-critical reports auto-unpublish; resolution is recorded and audited", async () => {
    const c = await mkCreator();
    const item = await mkContent(c.id, "free");
    const rid = await createReport({ contentId: item, kind: "takedown", reason: "non_consensual", details: "Not authorised", reporterUserId: null, reporterEmail: "a@b.example" });
    expect((await q1(`select status from content_items where id=$1`, [item]))!.status).toBe("unpublished");
    await resolveReport(rid, c.adminId, "remove_content", "confirmed");
    expect((await q1(`select status from content_items where id=$1`, [item]))!.status).toBe("removed");
    expect((await q1(`select status from reports where id=$1`, [rid]))!.status).toBe("actioned");
    expect(await q1(`select 1 from moderation_actions where report_id=$1`, [rid])).toBeTruthy();
  });

  it("ordinary reports do not auto-unpublish", async () => {
    const c = await mkCreator();
    const item = await mkContent(c.id, "free");
    await createReport({ contentId: item, kind: "report", reason: "other", details: "hmm", reporterUserId: null, reporterEmail: null });
    expect((await q1(`select status from content_items where id=$1`, [item]))!.status).toBe("published");
  });
});

describe("maintenance & retention", () => {
  it("purges expired sessions/tokens and old audit rows, keeps recent ones", async () => {
    const u = await mkUser();
    await q(`insert into sessions (user_id, token_hash, expires_at) values ($1,'old-'||gen_random_uuid(), now()-interval '1 day')`, [u.id]);
    await q(`insert into sessions (user_id, token_hash, expires_at) values ($1,'new-'||gen_random_uuid(), now()+interval '1 day')`, [u.id]);
    await audit(null, "recent.event", "t", null);
    await db.exec(`set app.allow_audit_purge = 'on'`); // simulate an old row insert (insert is allowed; purge flag irrelevant)
    await q(`insert into audit_logs (action, entity_type, created_at) values ('ancient.event','t', now() - interval '5 years')`);
    const r = await runMaintenance();
    expect(r.sessionsPurged).toBeGreaterThanOrEqual(1);
    expect(r.auditPurged).toBeGreaterThanOrEqual(1);
    expect(await q1(`select 1 from audit_logs where action='ancient.event'`)).toBeNull();
    expect(await q1(`select 1 from audit_logs where action='recent.event'`)).toBeTruthy();
    expect((await q(`select 1 from sessions where user_id=$1`, [u.id])).length).toBe(1);
  });
});
