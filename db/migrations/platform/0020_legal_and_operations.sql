-- Legal and operations (P4-8, docs/26 §6–§8, docs/27 §3.15): versioned terms and privacy policy
-- with acceptances, tenant data exports, data-protection requests, the status page's incidents
-- and the restore drill schedule.

-- Terms of service, privacy policy and data processing agreement, versioned. Only one published
-- version of a kind is current: the newest whose effective date has come.
create table legal_documents (
  id             uuid primary key default uuidv7(),
  kind           text not null check (kind in ('terms', 'privacy', 'dpa')),
  version        text not null check (version ~ '^[0-9A-Za-z.-]{1,20}$'),
  title          text not null check (length(trim(title)) between 3 and 160),
  body           text not null check (length(body) between 20 and 200000),
  summary        text check (length(summary) <= 2000),
  -- Owners must accept it again (a material change); otherwise it is only shown.
  requires_acceptance boolean not null default true,
  status         text not null default 'draft' check (status in ('draft', 'published')),
  effective_at   timestamptz,
  published_at   timestamptz,
  created_by     uuid not null references platform_users (id),
  created_at     timestamptz not null default now(),
  unique (kind, version),
  check ((status = 'published') = (published_at is not null and effective_at is not null))
);

-- Who accepted which version: an applicant at sign-up, or a tenant's owner in the app.
create table legal_acceptances (
  id              uuid primary key default uuidv7(),
  document_id     uuid not null references legal_documents (id),
  tenant_id       uuid references tenants (id),
  application_id  uuid references tenant_applications (id),
  tenant_user_id  uuid,
  context         text not null check (context in ('signup', 'app')),
  accepted_at     timestamptz not null default now(),
  ip              inet,
  user_agent      text check (length(user_agent) <= 500),
  check (tenant_id is not null or application_id is not null)
);

create unique index legal_acceptances_tenant_idx on legal_acceptances (document_id, tenant_id)
  where tenant_id is not null;
create index legal_acceptances_application_idx on legal_acceptances (application_id)
  where application_id is not null;

revoke update, delete, truncate on legal_acceptances from af_platform_rw;

-- "Export all my data" (docs/26 §6): a zip in private storage, linked for 7 days.
create table tenant_data_exports (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references tenants (id),
  requested_by_type  text not null check (requested_by_type in ('user', 'platform_staff')),
  requested_by       uuid not null,
  status             text not null default 'queued'
                     check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  storage_key        text,
  size_bytes         bigint,
  tables             integer,
  files_included     integer,
  files_skipped      integer,
  error              text check (length(error) <= 1000),
  requested_at       timestamptz not null default now(),
  completed_at       timestamptz,
  expires_at         timestamptz,
  downloads          integer not null default 0,
  last_downloaded_at timestamptz,
  check ((status = 'ready') <= (storage_key is not null and expires_at is not null))
);

create index tenant_data_exports_tenant_idx on tenant_data_exports (tenant_id, requested_at desc);

-- Data-protection requests (access, correction, erasure, objection; docs/27 §3.15), tracked to
-- their deadline with every step.
create table data_protection_requests (
  id               uuid primary key default uuidv7(),
  -- DPR-2026-0001.
  code             text not null unique,
  kind             text not null check (kind in ('access', 'correction', 'erasure', 'objection')),
  tenant_id        uuid references tenants (id),
  requester_name   text not null check (length(trim(requester_name)) between 2 and 160),
  requester_contact text not null check (length(trim(requester_contact)) between 5 and 200),
  -- Whose data: the requester, or a person they act for (described, never their ID number).
  subject          text not null check (length(trim(subject)) between 3 and 1000),
  received_at      timestamptz not null,
  due_at           timestamptz not null,
  status           text not null default 'open'
                   check (status in ('open', 'in_progress', 'completed', 'rejected')),
  assigned_to      uuid references platform_users (id),
  -- [{ at, by, note }]
  steps            jsonb not null default '[]'::jsonb,
  outcome          text check (length(outcome) <= 2000),
  closed_at        timestamptz,
  created_by       uuid not null references platform_users (id),
  created_at       timestamptz not null default now(),
  check ((status in ('completed', 'rejected')) = (closed_at is not null and outcome is not null))
);

create index data_protection_requests_open_idx on data_protection_requests (due_at)
  where status in ('open', 'in_progress');

-- The public status page: incidents and their updates (docs/27 §3.1).
create table incidents (
  id           uuid primary key default uuidv7(),
  title        text not null check (length(trim(title)) between 3 and 160),
  impact       text not null check (impact in ('minor', 'major', 'critical')),
  status       text not null check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  components   text[] not null default '{}',
  started_at   timestamptz not null,
  resolved_at  timestamptz,
  created_by   uuid not null references platform_users (id),
  created_at   timestamptz not null default now(),
  check ((status = 'resolved') = (resolved_at is not null))
);

create index incidents_recent_idx on incidents (started_at desc);

create table incident_updates (
  id           uuid primary key default uuidv7(),
  incident_id  uuid not null references incidents (id),
  status       text not null check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  message      text not null check (length(trim(message)) between 3 and 2000),
  posted_by    uuid not null references platform_users (id),
  posted_at    timestamptz not null default now()
);

create index incident_updates_idx on incident_updates (incident_id, posted_at);

-- Restore drills (docs/26 §7): a quarterly game day is always scheduled; results are recorded.
create table restore_drills (
  id            uuid primary key default uuidv7(),
  kind          text not null check (kind in ('quarterly_game_day', 'restore_test')),
  due_on        date not null,
  status        text not null default 'scheduled' check (status in ('scheduled', 'done', 'missed')),
  performed_at  timestamptz,
  performed_by  uuid references platform_users (id),
  outcome       text check (outcome in ('passed', 'partial', 'failed')),
  rto_minutes   integer check (rto_minutes >= 0),
  rpo_minutes   integer check (rpo_minutes >= 0),
  notes         text check (length(notes) <= 4000),
  created_at    timestamptz not null default now(),
  check ((status = 'done') = (performed_at is not null and outcome is not null))
);

create unique index restore_drills_scheduled_idx on restore_drills (kind) where status = 'scheduled';
