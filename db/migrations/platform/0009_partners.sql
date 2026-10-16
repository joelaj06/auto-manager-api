-- Reseller programme, part A (P1-7, docs/29): partner profiles, partner console users,
-- per-partner capability grants, and tenant attribution. Commission terms and ledgers: phase 2.

create table partners (
  id                 uuid primary key default uuidv7(),
  name               text not null check (length(trim(name)) between 2 and 120),
  kind               text not null default 'company' check (kind in ('individual', 'company')),
  contact_name       text not null check (length(trim(contact_name)) between 2 and 120),
  email              citext not null unique check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  phone              text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  region             text check (length(region) <= 120),
  address            text check (length(address) <= 500),
  tin                text check (length(tin) <= 40),
  status             text not null default 'active'
                     check (status in ('active', 'paused', 'terminated')),
  status_reason      text,
  status_changed_at  timestamptz,
  -- Applications from trusted partners may skip manual review (later); off by default.
  trusted            boolean not null default false,
  referral_code      text not null unique check (referral_code ~ '^[A-Z0-9]{4,16}$'),
  created_by         uuid references platform_users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            integer not null default 1
);

create index partners_status_idx on partners (status, name);

-- What a partner's console users may see and do (docs/29 §7), granted per partner.
create table partner_permission_grants (
  partner_id      uuid not null references partners (id),
  permission_key  text not null references platform_permissions (key),
  granted_by      uuid references platform_users (id),
  granted_at      timestamptz not null default now(),
  primary key (partner_id, permission_key)
);

alter table platform_users
  add column user_type  text not null default 'staff' check (user_type in ('staff', 'partner')),
  add column partner_id uuid references partners (id),
  add constraint platform_users_partner_check check ((user_type = 'partner') = (partner_id is not null));

create index platform_users_partner_idx on platform_users (partner_id) where partner_id is not null;

-- Partner users never hold staff roles.
create function forbid_partner_roles() returns trigger
  language plpgsql
as $$
begin
  if exists (select 1 from platform_users where id = new.user_id and user_type = 'partner') then
    raise exception 'partner users cannot hold staff roles'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger platform_user_roles_staff_only
  before insert or update on platform_user_roles
  for each row execute function forbid_partner_roles();

alter table tenant_applications
  add constraint tenant_applications_partner_fk foreign key (partner_id) references partners (id);

create index tenant_applications_partner_idx on tenant_applications (partner_id, created_at desc)
  where partner_id is not null;

-- One partner per tenant (docs/29 §3). Changes after the fact: Super Admin only, audited.
create table partner_tenant_attributions (
  tenant_id       uuid primary key references tenants (id),
  partner_id      uuid not null references partners (id),
  source          text not null check (source in ('referral_code', 'assisted', 'manual')),
  application_id  uuid references tenant_applications (id),
  attributed_by   uuid references platform_users (id),
  reason          text,
  attributed_at   timestamptz not null default now()
);

create index partner_tenant_attributions_partner_idx
  on partner_tenant_attributions (partner_id, attributed_at desc);
