-- Platform staff, roles, sessions and four-eyes approvals (P1-1, docs/27 §1–2, §8; docs/28 §12).
-- Staff are invite-only, MFA is mandatory, and every action lands in platform_audit_logs.

-- Platform permission catalogue: synced from the code catalogue by `yarn db:migrate`.
create table platform_permissions (
  key           text primary key check (key ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  description   text not null,
  sensitive     boolean not null default false,
  -- Executed only after a second staff member approves (docs/27 §8).
  four_eyes     boolean not null default false,
  deprecated    boolean not null default false,
  synced_at     timestamptz not null default now()
);

create table platform_roles (
  id             uuid primary key default uuidv7(),
  -- Set for system roles seeded from code (super_admin, operations, …); null for custom roles.
  system_key     text unique check (system_key ~ '^[a-z][a-z_]*$'),
  name           text not null unique check (length(trim(name)) between 1 and 80),
  description    text not null default '',
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table platform_role_permissions (
  role_id        uuid not null references platform_roles (id) on delete cascade,
  permission_key text not null references platform_permissions (key),
  primary key (role_id, permission_key)
);

create table platform_users (
  id                     uuid primary key default uuidv7(),
  email                  citext not null unique check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  name                   text not null check (length(trim(name)) between 1 and 120),
  status                 text not null default 'invited'
                         check (status in ('invited', 'active', 'disabled')),
  password_hash          text,
  -- TOTP secret, encrypted with MFA_ENCRYPTION_KEY (never stored in clear).
  totp_secret_enc        text,
  totp_enrolled_at       timestamptz,
  -- Last accepted TOTP time step: a code can never be used twice.
  totp_last_step         bigint,
  -- Bumped whenever roles change or the account is disabled: outstanding tokens stop working.
  permission_version     integer not null default 1 check (permission_version > 0),
  failed_attempts        integer not null default 0 check (failed_attempts >= 0),
  locked_until           timestamptz,
  last_login_at          timestamptz,
  invited_by             uuid references platform_users (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (status <> 'active' or (password_hash is not null and totp_enrolled_at is not null))
);

create table platform_user_roles (
  user_id     uuid not null references platform_users (id),
  role_id     uuid not null references platform_roles (id) on delete cascade,
  assigned_by uuid references platform_users (id),
  assigned_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table platform_invitations (
  id          uuid primary key default uuidv7(),
  user_id     uuid not null references platform_users (id),
  token_hash  text not null unique,
  invited_by  uuid references platform_users (id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  check (expires_at > created_at)
);

create index platform_invitations_user_idx on platform_invitations (user_id, created_at desc);

-- Signed-in staff devices. Checked on every console request (idle and absolute expiry).
create table platform_sessions (
  id                          uuid primary key,
  user_id                     uuid not null references platform_users (id),
  refresh_token_hash          text not null unique,
  previous_refresh_token_hash text,
  created_at                  timestamptz not null,
  last_rotated_at             timestamptz not null,
  last_seen_at                timestamptz not null,
  expires_at                  timestamptz not null,
  -- Last successful re-authentication (password + code) for sensitive actions.
  step_up_at                  timestamptz,
  revoked_at                  timestamptz,
  revocation_reason           text
                              check (revocation_reason in ('logout', 'refresh_token_reuse',
                                                           'password_changed', 'user_disabled',
                                                           'admin_revoked', 'idle_timeout')),
  user_agent                  text,
  ip                          inet,
  check ((revoked_at is null) = (revocation_reason is null))
);

create index platform_sessions_user_active_idx on platform_sessions (user_id) where revoked_at is null;

-- Devices a staff member has signed in from; a new one triggers a security email.
create table platform_known_devices (
  user_id       uuid not null references platform_users (id),
  device_hash   text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (user_id, device_hash)
);

-- Four-eyes approvals: the requester can never approve their own request.
create table platform_approval_requests (
  id              uuid primary key default uuidv7(),
  action          text not null check (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  payload         jsonb not null,
  summary         text not null,
  reason          text not null check (length(trim(reason)) >= 5),
  ticket          text,
  target_tenant_id uuid references tenants (id),
  requested_by    uuid not null references platform_users (id),
  requested_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected', 'expired', 'failed')),
  decided_by      uuid references platform_users (id),
  decided_at      timestamptz,
  decision_note   text,
  executed_at     timestamptz,
  result          jsonb,
  error           text,
  check (decided_by is null or decided_by <> requested_by),
  check ((status in ('pending', 'expired')) = (decided_by is null))
);

create index platform_approval_requests_pending_idx
  on platform_approval_requests (requested_at) where status = 'pending';
