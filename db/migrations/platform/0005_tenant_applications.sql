-- Tenant applications (P1-2, docs/27 §3.2): self-signup and assisted signup create an
-- application; staff approve, reject or ask for more information. No tenant database exists until
-- approval (provisioning, P1-3).

create table tenant_applications (
  id                   uuid primary key default uuidv7(),
  status               text not null default 'pending_verification'
                       check (status in ('pending_verification', 'pending_review', 'needs_info',
                                         'approved', 'rejected')),
  source               text not null default 'self' check (source in ('self', 'assisted')),
  business_name        text not null check (length(trim(business_name)) between 2 and 120),
  business_type        text not null check (business_type in ('fleet', 'rental', 'dealer', 'mixed')),
  country              char(2) not null default 'GH' check (country ~ '^[A-Z]{2}$'),
  desired_slug         citext not null check (desired_slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$'),
  contact_name         text not null check (length(trim(contact_name)) between 2 and 120),
  contact_email        citext not null check (contact_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  contact_phone        text not null check (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  tin                  text check (length(tin) <= 40),
  registration_number  text check (length(registration_number) <= 60),
  expected_branches    integer not null check (expected_branches between 1 and 1000),
  expected_vehicles    integer not null check (expected_vehicles between 0 and 100000),
  heard_about          text check (length(heard_about) <= 200),
  referral_code        text check (length(referral_code) <= 40),
  -- Reseller attribution arrives with P1-7; the column is ready for it.
  partner_id           uuid,
  created_by_staff_id  uuid references platform_users (id),
  -- Applicant's private link: only the SHA-256 of the token is stored.
  access_token_hash    text not null unique,
  email_verified_at    timestamptz,
  phone_verified_at    timestamptz,
  submitted_at         timestamptz,
  risk_level           text not null default 'low' check (risk_level in ('low', 'medium', 'high')),
  risk_signals         jsonb not null default '[]'::jsonb,
  assigned_to          uuid references platform_users (id),
  reviewed_by          uuid references platform_users (id),
  reviewed_at          timestamptz,
  decision_reason      text,
  reapply_after        timestamptz,
  -- Choices made at approval (plan, trial length, …), used by provisioning (P1-3).
  approval_options     jsonb,
  tenant_id            uuid references tenants (id),
  created_ip           inet,
  created_user_agent   text,
  terms_accepted_at    timestamptz not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check ((status = 'pending_review') <= (email_verified_at is not null and phone_verified_at is not null))
);

create index tenant_applications_queue_idx on tenant_applications (status, submitted_at)
  where status in ('pending_review', 'needs_info');
create index tenant_applications_email_idx on tenant_applications (contact_email, created_at desc);
create index tenant_applications_phone_idx on tenant_applications (contact_phone, created_at desc);
create index tenant_applications_slug_idx on tenant_applications (desired_slug)
  where status <> 'rejected';
create index tenant_applications_ip_idx on tenant_applications (created_ip, created_at desc)
  where created_ip is not null;

-- Timeline: status changes and the messages exchanged with the applicant.
create table tenant_application_events (
  id              uuid primary key default uuidv7(),
  application_id  uuid not null references tenant_applications (id),
  type            text not null check (type in ('submitted', 'verified', 'info_requested',
                                                'applicant_replied', 'approved', 'rejected',
                                                'assigned', 'note')),
  actor_type      text not null check (actor_type in ('applicant', 'platform_staff', 'system')),
  actor_id        uuid,
  -- Shown to the applicant (info requests, decisions) unless internal.
  message         text,
  internal        boolean not null default false,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index tenant_application_events_app_idx
  on tenant_application_events (application_id, created_at);

revoke update, delete, truncate on tenant_application_events from af_platform_rw;
create trigger tenant_application_events_append_only
  before update or delete on tenant_application_events
  for each row execute function forbid_mutation();

-- One-time codes for platform-level verification (signup email/phone). Same shape as the tenant
-- table otp_challenges.
create table platform_otp_challenges (
  id             uuid primary key,
  subject        text not null check (length(subject) between 1 and 320),
  purpose        text not null
                 check (purpose in ('email_verification', 'phone_verification', 'password_reset',
                                    'login_verification', 'document_signing',
                                    'billing_extension')),
  code_hash      text not null,
  attempts       integer not null default 0 check (attempts >= 0),
  max_attempts   integer not null check (max_attempts > 0),
  created_at     timestamptz not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  invalidated_at timestamptz,
  check (expires_at > created_at),
  check (consumed_at is null or invalidated_at is null)
);

create index platform_otp_challenges_open_idx
  on platform_otp_challenges (subject, purpose, created_at desc)
  where consumed_at is null and invalidated_at is null;
