-- Brooke's Closet — initial schema (PostgreSQL 14+; also runs on embedded PGlite)
-- Conventions: uuid PKs, timestamptz, CHECK-constrained text enums, integer cents.
-- Money is stored in minor units. Prices are rows, never constants.

create table users (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null,
  password_hash      text not null,
  display_name       text,
  role               text not null default 'member' check (role in ('member','moderator','admin')),
  status             text not null default 'active' check (status in ('active','suspended','deleted')),
  email_verified_at  timestamptz,
  adult_confirmed_at timestamptz not null,
  terms_accepted_at  timestamptz not null,
  terms_version      text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint users_email_lowercase check (email = lower(email))
);
create unique index users_email_key on users (email);
create index users_role_idx on users (role) where role <> 'member';

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,           -- sha256 of the cookie token; raw token is never stored
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  user_agent  text
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

create table email_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null check (kind in ('verify_email','reset_password')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index email_tokens_user_idx on email_tokens (user_id, kind);

-- Consent & eligibility evidence for members (append-only by convention).
create table consent_records (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  kind       text not null check (kind in ('adult_confirmation','terms','privacy')),
  version    text not null,
  created_at timestamptz not null default now()
);
create index consent_records_user_idx on consent_records (user_id);

-- ───────────────────────── Creators ─────────────────────────
create table creators (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete set null,  -- optional login linkage for future creator portal
  slug         text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  display_name text not null check (char_length(display_name) between 1 and 80),
  bio          text not null default '' check (char_length(bio) <= 4000),
  avatar_key   text,                                  -- private storage key; admin-approved image only
  is_owner     boolean not null default false,
  status       text not null default 'draft'
               check (status in ('draft','pending_review','approved','rejected','suspended')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index creators_single_owner on creators (is_owner) where is_owner;
create index creators_status_idx on creators (status);

-- Age & consent verification. Documents are NOT stored in this DB or the media bucket;
-- document_ref is only an opaque pointer to a separate, restricted system.
create table creator_verifications (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references creators(id) on delete cascade,
  status           text not null default 'pending' check (status in ('pending','approved','rejected')),
  age_verified     boolean not null default false,
  consent_on_file  boolean not null default false,
  consent_signed_at timestamptz,
  document_ref     text,
  notes            text,
  reviewed_by      uuid references users(id),
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint verification_approval_requirements check (
    status <> 'approved' or (age_verified and consent_on_file and consent_signed_at is not null
                             and reviewed_by is not null and reviewed_at is not null)
  )
);
create index creator_verifications_creator_idx on creator_verifications (creator_id, created_at desc);

-- A creator can only be approved while a valid approved verification exists.
create function enforce_creator_verified() returns trigger language plpgsql as $$
begin
  if new.status = 'approved' and not exists (
    select 1 from creator_verifications v
    where v.creator_id = new.id and v.status = 'approved'
      and v.age_verified and v.consent_on_file
  ) then
    raise exception 'creator % cannot be approved without an approved age/consent verification', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger creators_require_verification
  before insert or update of status on creators
  for each row execute function enforce_creator_verified();

-- ───────────────────────── Content ─────────────────────────
create table content_items (
  id            uuid primary key default gen_random_uuid(),
  creator_id    uuid not null references creators(id) on delete restrict,
  title         text not null check (char_length(title) between 1 and 160),
  description   text not null default '' check (char_length(description) <= 5000),
  kind          text not null check (kind in ('photo','video')),
  access_level  text not null default 'package' check (access_level in ('public','free','package','subscription')),
  status        text not null default 'draft' check (status in ('draft','published','unpublished','removed')),
  storage_key   text not null,
  thumbnail_key text,
  mime_type     text not null,
  size_bytes    integer not null check (size_bytes > 0),
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index content_creator_idx on content_items (creator_id, status);
create index content_listing_idx on content_items (status, published_at desc);
create index content_access_idx on content_items (access_level) where status = 'published';

-- Content can only be published for an approved creator.
create function enforce_publishable() returns trigger language plpgsql as $$
begin
  if new.status = 'published' and not exists (
    select 1 from creators c where c.id = new.creator_id and c.status = 'approved'
  ) then
    raise exception 'content cannot be published for a creator that is not approved'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger content_require_approved_creator
  before insert or update of status, creator_id on content_items
  for each row execute function enforce_publishable();

create table collections (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid references creators(id) on delete cascade,   -- null = site-wide collection
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title       text not null check (char_length(title) between 1 and 160),
  description text not null default '',
  created_at  timestamptz not null default now()
);
create index collections_creator_idx on collections (creator_id);

create table collection_items (
  collection_id uuid not null references collections(id) on delete cascade,
  content_id    uuid not null references content_items(id) on delete cascade,
  position      integer not null default 0,
  primary key (collection_id, content_id)
);
create index collection_items_content_idx on collection_items (content_id);

-- ───────────────────────── Products ─────────────────────────
create table packages (           -- one-time purchases
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  price_cents integer not null check (price_cents >= 0),
  currency    text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  creator_id  uuid references creators(id) on delete set null,
  active      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table package_items (      -- a package contains individual items and/or whole collections
  id            uuid primary key default gen_random_uuid(),
  package_id    uuid not null references packages(id) on delete cascade,
  content_id    uuid references content_items(id) on delete cascade,
  collection_id uuid references collections(id) on delete cascade,
  constraint package_item_one_target check ((content_id is null) <> (collection_id is null))
);
create unique index package_items_content_key on package_items (package_id, content_id) where content_id is not null;
create unique index package_items_collection_key on package_items (package_id, collection_id) where collection_id is not null;
create index package_items_content_idx on package_items (content_id);
create index package_items_collection_idx on package_items (collection_id);

create table membership_plans (   -- recurring subscriptions
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  price_cents integer not null check (price_cents >= 0),
  currency    text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  interval    text not null default 'month' check (interval in ('month')),
  creator_id  uuid references creators(id) on delete set null, -- null = all-creator plan; set = that creator's subscription-only content
  benefits    jsonb not null default '[]'::jsonb,
  active      boolean not null default false,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ───────────────────────── Commerce ─────────────────────────
create table checkout_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete restrict,
  kind         text not null check (kind in ('package','plan')),
  package_id   uuid references packages(id),
  plan_id      uuid references membership_plans(id),
  amount_cents integer not null check (amount_cents >= 0),
  currency     text not null,
  provider     text not null,
  provider_ref text,
  status       text not null default 'open' check (status in ('open','completed','canceled','expired')),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  constraint checkout_target check (
    (kind = 'package' and package_id is not null and plan_id is null) or
    (kind = 'plan' and plan_id is not null and package_id is null))
);
create index checkout_sessions_user_idx on checkout_sessions (user_id);

create table purchases (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete restrict,
  package_id          uuid not null references packages(id) on delete restrict,
  checkout_session_id uuid unique references checkout_sessions(id),
  amount_cents        integer not null check (amount_cents >= 0),
  currency            text not null,
  status              text not null default 'pending' check (status in ('pending','paid','refunded','failed')),
  provider            text not null,
  provider_ref        text,
  paid_at             timestamptz,
  refunded_at         timestamptz,
  created_at          timestamptz not null default now()
);
create index purchases_user_idx on purchases (user_id, created_at desc);
create index purchases_package_idx on purchases (package_id);

create table subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id) on delete restrict,
  plan_id              uuid not null references membership_plans(id) on delete restrict,
  checkout_session_id  uuid unique references checkout_sessions(id),
  status               text not null default 'pending'
                       check (status in ('pending','active','past_due','canceled','expired','revoked')),
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at          timestamptz,
  provider             text not null,
  provider_ref         text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint subscription_active_has_period check (
    status not in ('active','canceled') or (current_period_start is not null and current_period_end is not null))
);
create index subscriptions_user_idx on subscriptions (user_id, status);
create index subscriptions_period_idx on subscriptions (current_period_end) where status in ('active','canceled');
create unique index subscriptions_one_live_per_plan
  on subscriptions (user_id, plan_id) where status in ('pending','active','past_due');

create table entitlements (       -- grants of one-time package access
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  package_id     uuid not null references packages(id) on delete cascade,
  source         text not null check (source in ('purchase','admin_grant')),
  purchase_id    uuid references purchases(id) on delete set null,
  granted_by     uuid references users(id),
  granted_at     timestamptz not null default now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,
  constraint entitlement_purchase_link check (source <> 'purchase' or purchase_id is not null)
);
create unique index entitlements_one_active on entitlements (user_id, package_id) where revoked_at is null;
create index entitlements_package_idx on entitlements (package_id);

create table billing_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete restrict,
  type            text not null check (type in ('charge','renewal','refund','cancellation','revocation')),
  amount_cents    integer not null default 0,
  currency        text not null default 'USD',
  purchase_id     uuid references purchases(id) on delete set null,
  subscription_id uuid references subscriptions(id) on delete set null,
  description     text not null default '',
  created_at      timestamptz not null default now()
);
create index billing_events_user_idx on billing_events (user_id, created_at desc);

-- ───────────────────────── Livestreams ─────────────────────────
create table livestream_events (
  id            uuid primary key default gen_random_uuid(),
  creator_id    uuid not null references creators(id) on delete restrict,
  title         text not null check (char_length(title) between 1 and 160),
  description   text not null default '',
  access        text not null default 'subscriber' check (access in ('public','subscriber','purchase')),
  package_id    uuid references packages(id) on delete set null,
  status        text not null default 'scheduled' check (status in ('scheduled','live','ended','cancelled')),
  scheduled_at  timestamptz not null,
  provider      text,
  provider_ref  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint stream_purchase_needs_package check (access <> 'purchase' or package_id is not null)
);
create index livestreams_schedule_idx on livestream_events (status, scheduled_at);

-- ───────────────────────── Moderation & audit ─────────────────────────
create table reports (
  id               uuid primary key default gen_random_uuid(),
  content_id       uuid references content_items(id) on delete set null,
  creator_id       uuid references creators(id) on delete set null,
  reporter_user_id uuid references users(id) on delete set null,
  reporter_email   text,
  kind             text not null check (kind in ('report','takedown')),
  reason           text not null check (reason in ('non_consensual','underage_concern','copyright','impersonation','illegal','other')),
  details          text not null check (char_length(details) between 1 and 5000),
  status           text not null default 'open' check (status in ('open','reviewing','actioned','dismissed')),
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      uuid references users(id)
);
create index reports_status_idx on reports (status, created_at);

create table moderation_actions (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid references reports(id) on delete set null,
  content_id  uuid references content_items(id) on delete set null,
  creator_id  uuid references creators(id) on delete set null,
  actor_id    uuid not null references users(id),
  action      text not null check (action in ('dismiss','unpublish_content','remove_content','suspend_creator','note')),
  note        text not null default '',
  created_at  timestamptz not null default now()
);
create index moderation_actions_report_idx on moderation_actions (report_id);

create table audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid references users(id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  metadata    jsonb not null default '{}'::jsonb,   -- must never contain secrets, passwords or raw PII
  created_at  timestamptz not null default now()
);
create index audit_logs_created_idx on audit_logs (created_at desc);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);

-- Audit logs are append-only. The only permitted deletion is the retention job
-- (src/lib/maintenance.ts), which sets the transaction-local flag app.allow_audit_purge.
create function audit_logs_immutable() returns trigger language plpgsql as $$
begin
  if current_setting('app.allow_audit_purge', true) = 'on' and tg_op = 'DELETE' then
    return old;
  end if;
  raise exception 'audit_logs is append-only';
end $$;
create trigger audit_logs_no_update_delete
  before update or delete on audit_logs
  for each row execute function audit_logs_immutable();

-- ───────────────────────── Row-level security ─────────────────────────
-- The application connects with a privileged server-side role and enforces authorization in code
-- (src/lib/access.ts, src/lib/permissions.ts). RLS is defense in depth: with RLS enabled and NO
-- permissive policies, any other role (e.g. Supabase `anon` / `authenticated` via the Data API,
-- or a leaked read-only credential) sees and changes nothing. Verified in tests/rls.test.ts.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
