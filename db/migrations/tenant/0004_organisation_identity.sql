-- Organisation, branches, users, roles and permissions (P1-3 seeding; APIs in P1-5),
-- expense categories and tax-code placeholders. docs/28 §3.3.

create table organisation (
  singleton           boolean primary key default true check (singleton),
  name                text not null check (length(trim(name)) between 1 and 120),
  legal_name          text,
  country             char(2) not null default 'GH',
  base_currency       char(3) not null default 'GHS' check (base_currency ~ '^[A-Z]{3}$'),
  timezone            text not null default 'Africa/Accra',
  tin                 text,
  registration_number text,
  contact_email       citext,
  contact_phone       text,
  -- Permission catalogue version this tenant's permissions and system roles match.
  catalogue_version   integer not null default 0,
  settings            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table branches (
  id          uuid primary key default uuidv7(),
  code        text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  name        text not null check (length(trim(name)) between 1 and 120),
  status      text not null default 'active' check (status in ('active', 'inactive')),
  is_default  boolean not null default false,
  address     text,
  phone       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index branches_one_default_idx on branches (is_default) where is_default;

create table permissions (
  key               text primary key,
  module            text not null,
  description       text not null,
  scopes            text[] not null,
  sensitive         boolean not null default false,
  deprecated        boolean not null default false,
  catalogue_version integer not null
);

create table roles (
  id           uuid primary key default uuidv7(),
  name         text not null check (length(trim(name)) between 1 and 80),
  description  text not null default '',
  is_system    boolean not null default false,
  system_key   text unique,
  locked       boolean not null default false,
  -- Bumped when the role's permissions change (holders get new tokens).
  perm_version integer not null default 1,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  check (is_system = (system_key is not null))
);

create unique index roles_name_idx on roles (lower(name)) where deleted_at is null;

create table role_permissions (
  role_id        uuid not null references roles (id) on delete cascade,
  permission_key text not null references permissions (key),
  scope          text not null check (scope in ('own', 'branch', 'all')),
  limits         jsonb,
  primary key (role_id, permission_key)
);

create table users (
  id                 uuid primary key default uuidv7(),
  email              citext unique,
  phone              text unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  name               text not null check (length(trim(name)) between 1 and 120),
  status             text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  password_hash      text,
  is_owner           boolean not null default false,
  -- Bumped on role changes and disabling: outstanding access tokens stop working.
  permission_version integer not null default 1 check (permission_version > 0),
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (email is not null or phone is not null),
  check (status <> 'active' or password_hash is not null)
);

create table user_branches (
  user_id   uuid not null references users (id),
  branch_id uuid not null references branches (id),
  primary key (user_id, branch_id)
);

create table user_roles (
  id          uuid primary key default uuidv7(),
  user_id     uuid not null references users (id),
  role_id     uuid not null references roles (id),
  -- Null: the role applies to every branch the user belongs to.
  branch_id   uuid references branches (id),
  assigned_by uuid references users (id),
  assigned_at timestamptz not null default now(),
  unique nulls not distinct (user_id, role_id, branch_id)
);

-- One-time links for setting a password (owner welcome; staff invitations in P1-5).
create table user_invitations (
  id          uuid primary key default uuidv7(),
  user_id     uuid not null references users (id),
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  revoked_at  timestamptz
);

create index user_invitations_user_idx on user_invitations (user_id, created_at desc);

create table expense_categories (
  id         uuid primary key default uuidv7(),
  code       text not null unique check (code ~ '^[a-z][a-z_]{1,39}$'),
  name       text not null,
  is_system  boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Seeded inactive and without rates: each business sets its own (docs/21, decision 100).
create table tax_codes (
  id         uuid primary key default uuidv7(),
  code       text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  name       text not null,
  rate       numeric(7,4) check (rate is null or (rate >= 0 and rate <= 100)),
  active     boolean not null default false,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not active or rate is not null)
);
