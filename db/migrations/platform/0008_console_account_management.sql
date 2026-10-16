-- Console account management (P1-6, docs/27 §3.4): internal staff notes and tags per tenant,
-- plus indexes for the tenant list and dashboard.

create table tenant_notes (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenants (id),
  body        text not null check (length(trim(body)) between 1 and 5000),
  pinned      boolean not null default false,
  author_id   uuid not null references platform_users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Notes are never removed; a deleted note is hidden (the audit log keeps its text).
  deleted_at  timestamptz
);

create index tenant_notes_tenant_idx on tenant_notes (tenant_id, pinned desc, id desc)
  where deleted_at is null;

create table tenant_tags (
  tenant_id   uuid not null references tenants (id),
  tag         text not null check (tag ~ '^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$'),
  added_by    uuid references platform_users (id),
  added_at    timestamptz not null default now(),
  primary key (tenant_id, tag)
);

create index tenant_tags_tag_idx on tenant_tags (tag, tenant_id);

create index tenants_status_idx on tenants (status, id desc);
create index tenants_trial_ends_idx on tenants (trial_ends_at) where status = 'trialing';
create index tenant_applications_tenant_idx on tenant_applications (tenant_id)
  where tenant_id is not null;
