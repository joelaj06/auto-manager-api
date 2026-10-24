-- Console operations readiness (P4-7, docs/27 §2, §3.1, §3.7–§3.9, §3.12, §8): support access with
-- its trail, the alerts centre, announcements and maintenance windows, feature flags and
-- entitlement overrides, and daily usage.

-- Support access (impersonation, docs/27 §3.8): time-boxed, read-only by default; write mode
-- waits for a second staff member's approval. Every request in a session is logged.
create table support_sessions (
  id                uuid primary key default uuidv7(),
  staff_id          uuid not null references platform_users (id),
  -- The console session it belongs to: signing out of the console ends it.
  staff_session_id  uuid not null,
  tenant_id         uuid not null references tenants (id),
  mode              text not null check (mode in ('read', 'write')),
  reason            text not null check (length(trim(reason)) between 5 and 1000),
  ticket            text check (length(ticket) <= 120),
  status            text not null
                    check (status in ('awaiting_approval', 'approved', 'active', 'ended', 'rejected')),
  approval_id       uuid references platform_approval_requests (id),
  approved_by       uuid references platform_users (id),
  duration_minutes  integer not null check (duration_minutes between 5 and 120),
  requested_at      timestamptz not null default now(),
  started_at        timestamptz,
  expires_at        timestamptz,
  ended_at          timestamptz,
  end_reason        text check (end_reason in ('ended', 'expired', 'signed_out', 'revoked')),
  request_count     integer not null default 0,
  check ((status = 'active') <= (started_at is not null and expires_at is not null)),
  check ((status = 'ended') = (ended_at is not null))
);

create index support_sessions_staff_idx on support_sessions (staff_id, requested_at desc);
create index support_sessions_tenant_idx on support_sessions (tenant_id, requested_at desc);

create table support_session_requests (
  id           uuid primary key default uuidv7(),
  session_id   uuid not null references support_sessions (id),
  method       text not null,
  path         text not null check (length(path) <= 500),
  status_code  integer not null,
  request_id   text,
  at           timestamptz not null default now()
);

create index support_session_requests_session_idx on support_session_requests (session_id, at);

revoke update, delete, truncate on support_session_requests from af_platform_rw;

-- Tenants show their own support-access log by default (docs/27 §3.8).
alter table tenants add column support_log_visible boolean not null default true;

-- The alerts centre: one open alert per key, counted while it repeats.
create table platform_alerts (
  id               uuid primary key default uuidv7(),
  key              text not null check (length(key) between 3 and 200),
  severity         text not null check (severity in ('info', 'warning', 'critical')),
  source           text not null check (source ~ '^[a-z][a-z_]{1,40}$'),
  title            text not null check (length(title) between 3 and 200),
  detail           jsonb not null default '{}'::jsonb,
  tenant_id        uuid references tenants (id),
  runbook          text check (length(runbook) <= 300),
  status           text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  occurrences      integer not null default 1,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  acknowledged_by  uuid references platform_users (id),
  acknowledged_at  timestamptz,
  resolved_by      uuid references platform_users (id),
  resolved_at      timestamptz,
  notified_at      timestamptz
);

create unique index platform_alerts_open_key_idx on platform_alerts (key) where status <> 'resolved';
create index platform_alerts_status_idx on platform_alerts (status, last_seen_at desc);

-- Announcements to tenants (docs/27 §3.12): banners in the apps and, optionally, email to owners.
create table announcements (
  id            uuid primary key default uuidv7(),
  title         text not null check (length(trim(title)) between 3 and 120),
  body          text not null check (length(trim(body)) between 3 and 2000),
  severity      text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  -- { statuses?: [...], licenceTypes?: [...], tenantIds?: [...] }; empty: every tenant.
  audience      jsonb not null default '{}'::jsonb,
  email         boolean not null default false,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  status        text not null default 'draft'
                check (status in ('draft', 'awaiting_approval', 'published', 'withdrawn')),
  approval_id   uuid references platform_approval_requests (id),
  emailed_at    timestamptz,
  created_by    uuid not null references platform_users (id),
  created_at    timestamptz not null default now(),
  published_at  timestamptz,
  check (ends_at > starts_at)
);

create index announcements_live_idx on announcements (starts_at, ends_at) where status = 'published';

create table announcement_reads (
  announcement_id  uuid not null references announcements (id),
  tenant_id        uuid not null references tenants (id),
  user_id          uuid not null,
  read_at          timestamptz not null default now(),
  primary key (announcement_id, tenant_id, user_id)
);

-- Scheduled maintenance: a countdown banner, and optionally read-only for every tenant while on.
create table maintenance_windows (
  id           uuid primary key default uuidv7(),
  title        text not null check (length(trim(title)) between 3 and 120),
  message      text not null check (length(trim(message)) between 3 and 1000),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  read_only    boolean not null default false,
  status       text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  created_by   uuid not null references platform_users (id),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  check (ends_at > starts_at)
);

create index maintenance_windows_idx on maintenance_windows (starts_at, ends_at)
  where status = 'scheduled';

-- Feature flags and kill switches (docs/27 §3.9): a default, licence types, a percentage rollout,
-- per-tenant overrides; a flag can gate whole route prefixes of the tenant API.
create table feature_flags (
  key              text primary key check (key ~ '^[a-z][a-z0-9_.]{1,60}$'),
  description      text not null check (length(description) between 3 and 300),
  kind             text not null check (kind in ('feature', 'kill_switch')),
  enabled          boolean not null,
  rollout_percent  integer not null default 100 check (rollout_percent between 0 and 100),
  licence_types    text[] not null default '{}',
  route_prefixes   text[] not null default '{}',
  updated_by       uuid references platform_users (id),
  updated_at       timestamptz not null default now()
);

create table feature_flag_overrides (
  flag_key   text not null references feature_flags (key),
  tenant_id  uuid not null references tenants (id),
  enabled    boolean not null,
  reason     text not null check (length(trim(reason)) between 5 and 500),
  set_by     uuid not null references platform_users (id),
  set_at     timestamptz not null default now(),
  primary key (flag_key, tenant_id)
);

insert into feature_flags (key, description, kind, enabled, route_prefixes) values
  ('workpay', 'Work and pay (hire purchase) agreements', 'feature', true, '{/api/v1/workpay}'),
  ('documents', 'Documents and e-signature', 'feature', true, '{/api/v1/documents}'),
  ('driver_app', 'The driver app', 'feature', true, '{/api/v1/me/driver}'),
  ('documents.signing', 'Kill switch: e-signature everywhere', 'kill_switch', true,
   '{/api/v1/me/signatures,/api/v1/public/signing}');

-- More active branches than billed, granted by staff (a pilot, a goodwill gesture).
alter table subscriptions
  add column branch_limit_override integer check (branch_limit_override between 1 and 1000),
  add column branch_limit_override_reason text check (length(branch_limit_override_reason) <= 500),
  add check ((branch_limit_override is null) = (branch_limit_override_reason is null));

-- Tenant API calls per day, counted in each API process and flushed here.
create table api_usage (
  tenant_id  uuid not null references tenants (id),
  day        date not null,
  calls      bigint not null default 0,
  primary key (tenant_id, day)
);

-- One row per tenant and day (docs/27 §4): activity and size.
create table usage_daily (
  tenant_id        uuid not null references tenants (id),
  day              date not null,
  active_users     integer not null default 0,
  api_calls        bigint not null default 0,
  records_created  integer not null default 0,
  vehicles         integer not null default 0,
  branches         integer not null default 0,
  users            integer not null default 0,
  storage_bytes    bigint not null default 0,
  database_bytes   bigint not null default 0,
  collected_at     timestamptz not null default now(),
  primary key (tenant_id, day)
);
